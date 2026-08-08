import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { twitchConfig } from "./index.ts";
import { TwitchChatbot } from "./twitch.ts";

type FetchCall = { url: string; init: RequestInit | undefined };

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.OPEN;
  closed = false;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    if (this.readyState >= FakeWebSocket.CLOSING) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.closed = true;
    queueMicrotask(() => this.dispatchEvent(new CloseEvent("close")));
  }

  receive(value: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

function welcome(sessionId: string): unknown {
  return {
    metadata: { message_type: "session_welcome", message_id: `welcome-${sessionId}` },
    payload: { session: { id: sessionId, keepalive_timeout_seconds: 30 } },
  };
}

function notification(deliveryId: string, messageId: string, text: string, senderId = "user-1"): unknown {
  return {
    metadata: {
      message_type: "notification",
      message_id: deliveryId,
      subscription_type: "channel.chat.message",
    },
    payload: {
      event: {
        message_id: messageId,
        broadcaster_user_id: "channel-1",
        chatter_user_id: senderId,
        chatter_user_name: "Viewer",
        message: { text },
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(1);
  }
  throw new Error("Timed out waiting for test condition");
}

test("environment configuration is required and defaults the bot user", async () => {
  await assert.rejects(() => twitchConfig({}), /TWITCH_CLIENT_ID/);
  await assert.rejects(
    () => twitchConfig({ TWITCH_CLIENT_ID: "client", TWITCH_ACCESS_TOKEN: "token" }),
    /TWITCH_BROADCASTER_ID/,
  );
  assert.deepEqual(
    await twitchConfig({
      TWITCH_CLIENT_ID: "client",
      TWITCH_ACCESS_TOKEN: "token",
      TWITCH_BROADCASTER_ID: "channel",
    }),
    { clientId: "client", accessToken: "token", broadcasterId: "channel", botUserId: "channel" },
  );
});

test("TWITCH_CHANNEL resolves the broadcaster ID by login name", async () => {
  const realFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const responses: Response[] = [
    Response.json({ data: [{ id: "12345", login: "somechannel" }] }),
    Response.json({ data: [] }),
    new Response("unauthorized", { status: 401 }),
  ];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return responses.shift()!;
  }) as typeof fetch;

  try {
    const env = {
      TWITCH_CLIENT_ID: "client",
      TWITCH_ACCESS_TOKEN: "token",
      TWITCH_CHANNEL: "SomeChannel",
    };
    assert.deepEqual(await twitchConfig(env), {
      clientId: "client",
      accessToken: "token",
      broadcasterId: "12345",
      botUserId: "12345",
    });
    assert.equal(calls[0]!.url, "https://api.twitch.tv/helix/users?login=SomeChannel");
    assert.deepEqual(calls[0]!.init?.headers, {
      Authorization: "Bearer token",
      "Client-Id": "client",
    });

    await assert.rejects(() => twitchConfig(env), /Twitch channel not found: SomeChannel/);
    await assert.rejects(() => twitchConfig(env), /Twitch user lookup failed \(401\)/);
    assert.equal(responses.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Twitch chat receives, deduplicates, sends, replies, reconnects, and closes", async () => {
  const realWebSocket = globalThis.WebSocket;
  const realFetch = globalThis.fetch;
  const calls: FetchCall[] = [];
  const sendResponses: unknown[] = [];
  let bot: TwitchChatbot | undefined;
  FakeWebSocket.instances.length = 0;

  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/eventsub/subscriptions")) return new Response("", { status: 202 });
    if (url.endsWith("/chat/messages")) {
      return Response.json(sendResponses.shift() ?? { data: [] });
    }
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    bot = new TwitchChatbot({
      clientId: "client-id",
      accessToken: "secret-token",
      broadcasterId: "channel-1",
      botUserId: "bot-1",
    });
    const iterator = bot.messages()[Symbol.asyncIterator]();
    const firstMessage = iterator.next();
    await assert.rejects(bot.messages()[Symbol.asyncIterator]().next(), /only be consumed once/);

    sendResponses.push({ data: [{ message_id: "startup-1", is_sent: true, drop_reason: null }] });
    await waitFor(() => FakeWebSocket.instances.length === 1);
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.receive(welcome("session-1"));
    await waitFor(() => calls.some((call) => call.url.endsWith("/eventsub/subscriptions")));
    await waitFor(() => calls.some((call) => call.url.endsWith("/chat/messages")));

    const subscriptionCall = calls.find((call) => call.url.endsWith("/eventsub/subscriptions"))!;
    assert.equal(new Headers(subscriptionCall.init?.headers).get("Authorization"), "Bearer secret-token");
    assert.equal(new Headers(subscriptionCall.init?.headers).get("Client-Id"), "client-id");
    assert.deepEqual(JSON.parse(String(subscriptionCall.init?.body)), {
      type: "channel.chat.message",
      version: "1",
      condition: { broadcaster_user_id: "channel-1", user_id: "bot-1" },
      transport: { method: "websocket", session_id: "session-1" },
    });

    firstSocket.receive(notification("delivery-1", "message-1", "first"));
    assert.deepEqual(await firstMessage, {
      done: false,
      value: {
        id: "message-1",
        channelId: "channel-1",
        senderId: "user-1",
        senderName: "Viewer",
        text: "first",
      },
    });

    const secondMessage = iterator.next();
    firstSocket.receive(notification("delivery-self", "message-self", "bot message", "bot-1"));
    firstSocket.receive(notification("delivery-1", "message-1", "duplicate"));
    firstSocket.receive(notification("delivery-2", "message-2", "second"));
    assert.equal((await secondMessage).value?.text, "second");

    sendResponses.push({ data: [{ message_id: "sent-1", is_sent: true, drop_reason: null }] });
    assert.equal(await bot.sendMessage("hello"), "sent-1");
    sendResponses.push({ data: [{ message_id: "sent-2", is_sent: true, drop_reason: null }] });
    assert.equal(await bot.sendMessage("reply", "message-1"), "sent-2");

    const sendCalls = calls.filter((call) => call.url.endsWith("/chat/messages"));
    assert.deepEqual(JSON.parse(String(sendCalls[0]?.init?.body)), {
      broadcaster_id: "channel-1",
      sender_id: "bot-1",
      message: "Connected.",
    });
    assert.deepEqual(JSON.parse(String(sendCalls[1]?.init?.body)), {
      broadcaster_id: "channel-1",
      sender_id: "bot-1",
      message: "hello",
    });
    assert.deepEqual(JSON.parse(String(sendCalls[2]?.init?.body)), {
      broadcaster_id: "channel-1",
      sender_id: "bot-1",
      message: "reply",
      reply_parent_message_id: "message-1",
    });

    sendResponses.push({
      data: [{ message_id: "", is_sent: false, drop_reason: { code: "automod_held", message: "Held by AutoMod" } }],
    });
    await assert.rejects(bot.sendMessage("blocked"), /Held by AutoMod/);

    firstSocket.receive({
      metadata: { message_type: "session_reconnect", message_id: "reconnect-1" },
      payload: { session: { reconnect_url: "wss://eventsub.wss.twitch.tv/ws?session=reconnect" } },
    });
    await waitFor(() => FakeWebSocket.instances.length === 2);
    const replacementSocket = FakeWebSocket.instances[1]!;
    replacementSocket.receive(welcome("session-2"));
    await waitFor(() => firstSocket.closed);
    assert.equal(calls.filter((call) => call.url.endsWith("/eventsub/subscriptions")).length, 1);

    const finished = iterator.next();
    bot.close();
    assert.deepEqual(await finished, { done: true, value: undefined });
    const socketCount = FakeWebSocket.instances.length;
    await delay(1_050);
    assert.equal(FakeWebSocket.instances.length, socketCount);
  } finally {
    bot?.close();
    globalThis.WebSocket = realWebSocket;
    globalThis.fetch = realFetch;
  }
});
