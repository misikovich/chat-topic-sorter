import type { Chatbot, ChatMessage } from "./chatbot.ts";

const LOGTAG = "[TWITCH]";
const CONNECTED_MESSAGE = "Connected.";
const EVENTSUB_URL = "wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30";
const EVENTSUB_API = "https://api.twitch.tv/helix/eventsub/subscriptions";
const CHAT_API = "https://api.twitch.tv/helix/chat/messages";
const USERS_API = "https://api.twitch.tv/helix/users";
const RECONNECT_DELAYS = [1, 2, 4, 8, 16, 30] as const;
const SEEN_MESSAGE_LIMIT = 1_000;

export type TwitchConfig = {
  clientId: string;
  accessToken: string;
  broadcasterId: string;
  botUserId: string;
};

type JsonObject = Record<string, unknown>;

type SocketState = {
  url: string;
  subscribe: boolean;
  replacing: WebSocket | undefined;
  ready: boolean;
  intentionalClose: boolean;
  keepaliveSeconds: number;
};

type MessageWaiter = {
  resolve: (result: IteratorResult<ChatMessage>) => void;
  reject: (error: Error) => void;
};

class FatalTwitchError extends Error {}
class RetryableTwitchError extends Error {}

function object(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FatalTwitchError(`Malformed Twitch ${context}`);
  }
  return value as JsonObject;
}

function string(object: JsonObject, key: string, context: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new FatalTwitchError(`Malformed Twitch ${context}: missing ${key}`);
  }
  return value;
}

function detail(text: string): string {
  try {
    const body = object(JSON.parse(text), "API response");
    return typeof body.message === "string" ? body.message : text;
  } catch {
    return text;
  }
}

function error(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function twitchUserId(
  login: string,
  credentials: Pick<TwitchConfig, "clientId" | "accessToken">,
): Promise<string> {
  const url = new URL(USERS_API);
  url.searchParams.set("login", login);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Client-Id": credentials.clientId,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Twitch user lookup failed (${response.status}): ${detail(text)}`);
  }
  let body: JsonObject;
  try {
    body = object(JSON.parse(text), "user lookup response");
  } catch {
    throw new Error("Malformed Twitch user lookup response");
  }
  const data = body.data;
  if (!Array.isArray(data)) throw new Error("Malformed Twitch user lookup response");
  if (data.length === 0) throw new Error(`Twitch channel not found: ${login}`);
  return string(object(data[0], "user lookup response"), "id", "user lookup response");
}

export class TwitchChatbot implements Chatbot {
  readonly #config: TwitchConfig;
  readonly #queue: ChatMessage[] = [];
  readonly #seenMessageIds = new Set<string>();
  readonly #socketStates = new Map<WebSocket, SocketState>();

  #activeSocket: WebSocket | undefined;
  #pendingSocket: WebSocket | undefined;
  #waiter: MessageWaiter | undefined;
  #watchdog: ReturnType<typeof setTimeout> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempt = 0;
  #started = false;
  #announced = false;
  #closed = false;
  #failure: Error | undefined;

  constructor(config: TwitchConfig) {
    for (const [name, value] of Object.entries(config)) {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`Missing Twitch configuration: ${name}`);
      }
    }
    this.#config = { ...config };
    console.debug(LOGTAG, "configured", {
      broadcasterId: config.broadcasterId,
      botUserId: config.botUserId,
    });
  }

  messages(): AsyncIterable<ChatMessage> {
    return this.#iterate();
  }

  async sendMessage(text: string, replyToMessageId?: string): Promise<string> {
    if (typeof text !== "string" || text.trim() === "") {
      throw new Error("Twitch message must not be blank");
    }
    if (replyToMessageId !== undefined && replyToMessageId.trim() === "") {
      throw new Error("Twitch reply message ID must not be blank");
    }

    const response = await fetch(CHAT_API, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify({
        broadcaster_id: this.#config.broadcasterId,
        sender_id: this.#config.botUserId,
        message: text,
        ...(replyToMessageId === undefined ? {} : { reply_parent_message_id: replyToMessageId }),
      }),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Twitch send failed (${response.status}): ${detail(responseText)}`);
    }

    let body: JsonObject;
    try {
      body = object(JSON.parse(responseText), "send response");
    } catch {
      throw new Error("Malformed Twitch send response");
    }
    const data = body.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error("Malformed Twitch send response");
    }
    const result = object(data[0], "send response");
    if (result.is_sent !== true) {
      const drop = result.drop_reason;
      const message = typeof drop === "object" && drop !== null && "message" in drop
        ? String(drop.message)
        : "message was not sent";
      throw new Error(`Twitch send failed: ${message}`);
    }
    const messageId = string(result, "message_id", "send response");
    console.info(LOGTAG, "message sent", { messageId, replyToMessageId });
    return messageId;
  }

  close(): void {
    if (this.#closed) return;
    console.info(LOGTAG, "closing");
    this.#closed = true;
    this.#clearTimers();
    this.#closeSockets();
    if (this.#queue.length === 0 && this.#waiter !== undefined) {
      this.#waiter.resolve({ done: true, value: undefined });
      this.#waiter = undefined;
    }
  }

  async *#iterate(): AsyncGenerator<ChatMessage> {
    if (this.#started) throw new Error("Twitch messages can only be consumed once");
    this.#started = true;
    if (!this.#closed) this.#openSocket(EVENTSUB_URL, true, undefined);

    try {
      while (true) {
        const next = await this.#nextMessage();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      this.close();
    }
  }

  #nextMessage(): Promise<IteratorResult<ChatMessage>> {
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    const queued = this.#queue.shift();
    if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
    if (this.#closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
    });
  }

  #push(message: ChatMessage): void {
    if (this.#closed) return;
    if (this.#waiter !== undefined) {
      this.#waiter.resolve({ done: false, value: message });
      this.#waiter = undefined;
      return;
    }
    // ponytail: one-channel in-memory buffering; add persistence if restart replay becomes required.
    this.#queue.push(message);
  }

  #openSocket(url: string, subscribe: boolean, replacing: WebSocket | undefined): void {
    if (this.#closed) return;
    console.debug(LOGTAG, "opening EventSub socket", {
      mode: replacing === undefined ? "connect" : "server reconnect",
      subscribe,
    });

    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      console.warn(LOGTAG, "failed to open EventSub socket");
      this.#scheduleReconnect(url, subscribe, replacing);
      return;
    }

    const state: SocketState = {
      url,
      subscribe,
      replacing,
      ready: false,
      intentionalClose: false,
      keepaliveSeconds: 30,
    };
    this.#socketStates.set(socket, state);
    if (replacing === undefined) this.#activeSocket = socket;
    else this.#pendingSocket = socket;

    socket.addEventListener("message", (event) => {
      void this.#onSocketMessage(socket, state, event).catch((cause: unknown) => {
        const problem = error(cause);
        if (problem instanceof RetryableTwitchError) this.#retrySocket(socket);
        else this.#fail(problem);
      });
    });
    socket.addEventListener("close", (event) => this.#onSocketClose(socket, state, event));
  }

  async #onSocketMessage(socket: WebSocket, state: SocketState, event: MessageEvent): Promise<void> {
    if (this.#closed || !this.#socketStates.has(socket)) return;
    if (typeof event.data !== "string") throw new FatalTwitchError("Malformed Twitch WebSocket message");

    let envelope: JsonObject;
    try {
      envelope = object(JSON.parse(event.data), "WebSocket message");
    } catch {
      throw new FatalTwitchError("Malformed Twitch WebSocket message");
    }
    const metadata = object(envelope.metadata, "WebSocket metadata");
    const messageType = string(metadata, "message_type", "WebSocket metadata");

    if (messageType === "session_welcome") {
      if (state.ready) return;
      const payload = object(envelope.payload, "welcome payload");
      const session = object(payload.session, "welcome session");
      const sessionId = string(session, "id", "welcome session");
      const keepalive = session.keepalive_timeout_seconds;
      if (typeof keepalive !== "number" || !Number.isFinite(keepalive) || keepalive <= 0) {
        throw new FatalTwitchError("Malformed Twitch welcome session: missing keepalive timeout");
      }

      if (state.subscribe) await this.#subscribe(sessionId);
      if (this.#closed || !this.#socketStates.has(socket)) return;

      state.ready = true;
      state.keepaliveSeconds = keepalive;
      this.#cancelReconnect();
      this.#reconnectAttempt = 0;

      if (state.replacing !== undefined) {
        const oldSocket = state.replacing;
        this.#activeSocket = socket;
        this.#pendingSocket = undefined;
        const oldState = this.#socketStates.get(oldSocket);
        if (oldState !== undefined) oldState.intentionalClose = true;
        if (oldSocket.readyState < WebSocket.CLOSING) oldSocket.close();
      } else {
        this.#activeSocket = socket;
      }
      this.#resetWatchdog(socket, state);
      console.info(LOGTAG, "EventSub ready", {
        keepaliveSeconds: keepalive,
        reconnected: state.replacing !== undefined,
      });
      if (state.subscribe && !this.#announced) {
        this.#announced = true;
        try {
          await this.sendMessage(CONNECTED_MESSAGE);
        } catch (cause) {
          console.error(LOGTAG, "failed to send connection message", error(cause).message);
        }
      }
      return;
    }

    if (messageType === "session_keepalive") {
      if (state.ready) this.#resetWatchdog(socket, state);
      return;
    }

    if (messageType === "session_reconnect") {
      if (socket !== this.#activeSocket || !state.ready || this.#pendingSocket !== undefined) return;
      const payload = object(envelope.payload, "reconnect payload");
      const session = object(payload.session, "reconnect session");
      const reconnectUrl = string(session, "reconnect_url", "reconnect session");
      let parsed: URL;
      try {
        parsed = new URL(reconnectUrl);
      } catch {
        throw new FatalTwitchError("Malformed Twitch reconnect URL");
      }
      if (parsed.protocol !== "wss:" || parsed.hostname !== "eventsub.wss.twitch.tv") {
        throw new FatalTwitchError("Unexpected Twitch reconnect URL");
      }
      console.info(LOGTAG, "server requested reconnect");
      this.#clearWatchdog();
      this.#openSocket(reconnectUrl, false, socket);
      return;
    }

    if (messageType === "revocation") {
      const payload = object(envelope.payload, "revocation payload");
      const subscription = object(payload.subscription, "revocation subscription");
      const status = string(subscription, "status", "revocation subscription");
      throw new FatalTwitchError(`Twitch subscription revoked: ${status}`);
    }

    if (messageType !== "notification") return;
    if (!state.ready) throw new FatalTwitchError("Twitch notification received before welcome");
    this.#resetWatchdog(socket, state);
    if (metadata.subscription_type !== "channel.chat.message") return;

    const deliveryId = string(metadata, "message_id", "notification metadata");
    if (this.#seenMessageIds.has(deliveryId)) {
      console.debug(LOGTAG, "duplicate notification ignored", { deliveryId });
      return;
    }

    const payload = object(envelope.payload, "chat payload");
    const chatEvent = object(payload.event, "chat event");
    const senderId = string(chatEvent, "chatter_user_id", "chat event");
    if (senderId === this.#config.botUserId) {
      console.debug(LOGTAG, "self-authored message ignored", {
        messageId: string(chatEvent, "message_id", "chat event"),
      });
      return;
    }
    const message = object(chatEvent.message, "chat message");
    const chatMessage: ChatMessage = {
      id: string(chatEvent, "message_id", "chat event"),
      channelId: string(chatEvent, "broadcaster_user_id", "chat event"),
      senderId,
      senderName: string(chatEvent, "chatter_user_name", "chat event"),
      text: string(message, "text", "chat message"),
    };

    this.#seenMessageIds.add(deliveryId);
    if (this.#seenMessageIds.size > SEEN_MESSAGE_LIMIT) {
      const oldest = this.#seenMessageIds.values().next().value;
      if (oldest !== undefined) this.#seenMessageIds.delete(oldest);
    }
    console.debug(LOGTAG, "message received", {
      messageId: chatMessage.id,
      senderId: chatMessage.senderId,
      senderName: chatMessage.senderName,
    });
    this.#push(chatMessage);
  }

  async #subscribe(sessionId: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(EVENTSUB_API, {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({
          type: "channel.chat.message",
          version: "1",
          condition: {
            broadcaster_user_id: this.#config.broadcasterId,
            user_id: this.#config.botUserId,
          },
          transport: { method: "websocket", session_id: sessionId },
        }),
      });
    } catch (cause) {
      throw new RetryableTwitchError(`Twitch subscription request failed: ${error(cause).message}`);
    }

    if (response.ok) {
      console.info(LOGTAG, "chat subscription created", { broadcasterId: this.#config.broadcasterId });
      return;
    }
    const problem = `Twitch subscription failed (${response.status}): ${detail(await response.text())}`;
    if (response.status === 429 || response.status >= 500) throw new RetryableTwitchError(problem);
    throw new FatalTwitchError(problem);
  }

  #onSocketClose(socket: WebSocket, state: SocketState, event: CloseEvent): void {
    if (!this.#socketStates.delete(socket)) return;
    const wasActive = socket === this.#activeSocket;
    const wasPending = socket === this.#pendingSocket;
    if (wasActive) {
      this.#activeSocket = undefined;
      this.#clearWatchdog();
    }
    if (wasPending) this.#pendingSocket = undefined;
    if (this.#closed || state.intentionalClose) return;
    console.warn(LOGTAG, "EventSub socket closed unexpectedly", { code: event.code });

    if (wasPending && state.replacing !== undefined && this.#socketStates.has(state.replacing)) {
      this.#scheduleReconnect(state.url, state.subscribe, state.replacing);
      return;
    }
    if (wasActive && this.#pendingSocket !== undefined) return;

    this.#cancelReconnect();
    this.#scheduleReconnect(EVENTSUB_URL, true, undefined);
  }

  #retrySocket(socket: WebSocket): void {
    if (this.#closed || !this.#socketStates.has(socket)) return;
    console.warn(LOGTAG, "retrying EventSub connection after transient API failure");
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  }

  #scheduleReconnect(
    url: string,
    subscribe: boolean,
    replacing: WebSocket | undefined,
  ): void {
    if (this.#closed || this.#reconnectTimer !== undefined) return;
    const delay = RECONNECT_DELAYS[Math.min(this.#reconnectAttempt, RECONNECT_DELAYS.length - 1)] ?? 30;
    this.#reconnectAttempt++;
    console.warn(LOGTAG, "EventSub reconnect scheduled", {
      attempt: this.#reconnectAttempt,
      delaySeconds: delay,
    });
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#openSocket(url, subscribe, replacing);
    }, delay * 1_000);
  }

  #resetWatchdog(socket: WebSocket, state: SocketState): void {
    if (socket !== this.#activeSocket) return;
    this.#clearWatchdog();
    this.#watchdog = setTimeout(() => {
      this.#watchdog = undefined;
      if (!this.#closed && socket === this.#activeSocket && socket.readyState < WebSocket.CLOSING) {
        console.warn(LOGTAG, "EventSub keepalive timed out");
        socket.close();
      }
    }, (state.keepaliveSeconds + 1) * 1_000);
  }

  #fail(cause: unknown): void {
    if (this.#closed) return;
    this.#failure = error(cause);
    console.error(LOGTAG, "fatal error", this.#failure.message);
    this.#closed = true;
    this.#queue.length = 0;
    this.#clearTimers();
    this.#closeSockets();
    if (this.#waiter !== undefined) {
      this.#waiter.reject(this.#failure);
      this.#waiter = undefined;
    }
  }

  #headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#config.accessToken}`,
      "Client-Id": this.#config.clientId,
      "Content-Type": "application/json",
    };
  }

  #clearWatchdog(): void {
    if (this.#watchdog !== undefined) clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
  }

  #cancelReconnect(): void {
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #clearTimers(): void {
    this.#clearWatchdog();
    this.#cancelReconnect();
  }

  #closeSockets(): void {
    for (const [socket, state] of this.#socketStates) {
      state.intentionalClose = true;
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    }
    this.#socketStates.clear();
    this.#activeSocket = undefined;
    this.#pendingSocket = undefined;
  }
}
