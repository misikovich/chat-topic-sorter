import http from "node:http";

import type { ChatMessage } from "./chatbot.ts";
import { topics, type Topic } from "./topic.ts";

const LOGTAG = "[WEB]";
const CHAT_LOG_LIMIT = 200;
const TOPICS_POLL_MS = 1_000;
const KEEP_ALIVE_TICKS = 15;

export type MessageView = Readonly<{ id: string; senderName: string; text: string }>;
export type TopicView = Readonly<{
  status: Topic["status"];
  title: string | null;
  label: string | null;
  messages: MessageView[];
}>;

let Server: http.Server | null = null;
let Channel = "";
let ChatLog: ChatMessage[] = [];
let Clients = new Set<http.ServerResponse>();
let Poller: NodeJS.Timeout | null = null;
let LastTopicsJson = "";
let IdleTicks = 0;

function messageView(message: ChatMessage): MessageView {
  return { id: message.id, senderName: message.senderName, text: message.text };
}

export function web_topic_views(): TopicView[] {
  return topics()
    .map((topic) => ({
      status: topic.status,
      title: topic.title,
      label: topic.label,
      messages: topic.messages.map(messageView),
    }))
    .sort((a, b) => b.messages.length - a.messages.length);
}

function broadcast(event: string, payload: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of Clients) client.write(frame);
  IdleTicks = 0;
}

function pollTopics(): void {
  const json = JSON.stringify(web_topic_views());
  if (json !== LastTopicsJson) {
    LastTopicsJson = json;
    for (const client of Clients) client.write(`event: topics\ndata: ${json}\n\n`);
    IdleTicks = 0;
    return;
  }
  IdleTicks += 1;
  if (IdleTicks >= KEEP_ALIVE_TICKS) {
    for (const client of Clients) client.write(": keep-alive\n\n");
    IdleTicks = 0;
  }
}

function handleEvents(response: http.ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  response.write("retry: 2000\n\n");
  const init = { channel: Channel, chatLog: ChatLog.map(messageView), topics: web_topic_views() };
  response.write(`event: init\ndata: ${JSON.stringify(init)}\n\n`);
  Clients.add(response);
  response.on("close", () => Clients.delete(response));
}

function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
  const url = request.url ?? "/";
  if (url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(PAGE_HTML);
  } else if (url === "/events") {
    handleEvents(response);
  } else {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  }
}

export function web_start(options: { port: number; channel: string }): Promise<number> {
  if (Server !== null) throw new Error("Webserver already started");
  Channel = options.channel;
  const server = http.createServer(handleRequest);
  Server = server;
  Poller = setInterval(pollTopics, TOPICS_POLL_MS);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      console.info(LOGTAG, "listening", `http://localhost:${port}`);
      resolve(port);
    });
  });
}

export function web_message(message: ChatMessage): void {
  ChatLog.push(message);
  if (ChatLog.length > CHAT_LOG_LIMIT) ChatLog = ChatLog.slice(-CHAT_LOG_LIMIT);
  broadcast("message", messageView(message));
}

export function web_stop(): void {
  if (Poller !== null) clearInterval(Poller);
  Poller = null;
  for (const client of Clients) client.end();
  Clients = new Set();
  Server?.close();
  Server = null;
  ChatLog = [];
  LastTopicsJson = "";
  IdleTicks = 0;
  console.info(LOGTAG, "stopped");
}

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Twitch Chat Topic Sorter</title>
<style>
  :root {
    --bg: #0e0e12;
    --panel: #17171d;
    --border: #2a2a33;
    --text: #e6e6ea;
    --muted: #8a8a96;
    --accent: #9146ff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 14px/1.45 system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: grid;
    grid-template-rows: auto 1fr;
    grid-template-columns: 1fr 320px;
    grid-template-areas: "header header" "topics chat";
  }
  header {
    grid-area: header;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  header h1 { margin: 0; font-size: 16px; }
  header .channel { color: var(--accent); font-weight: 600; }
  main {
    grid-area: topics;
    overflow-y: auto;
    padding: 16px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 12px;
    align-content: start;
  }
  .card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
  }
  .card.unimportant { opacity: 0.5; }
  .card.candidate { opacity: 0.35; }
  .card h2 { margin: 0 0 8px; font-size: 14px; display: flex; align-items: center; gap: 8px; }
  .badge {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    padding: 1px 6px;
    border-radius: 4px;
    border: 1px solid var(--border);
    color: var(--muted);
  }
  .badge.status-candidate { color: #d9a441; border-color: #d9a441; }
  .badge.status-naming { color: #4fa3d9; border-color: #4fa3d9; }
  .count { margin-left: auto; font-size: 12px; font-weight: 400; color: var(--muted); }
  .card ul { margin: 0; padding: 0; list-style: none; }
  .card li { margin: 2px 0; padding: 0 4px; border-radius: 4px; overflow-wrap: anywhere; }
  .card li.flash { outline: 1px solid transparent; animation: flash 1.5s ease-out; }
  @keyframes flash { from { outline-color: #2dd4bf; } to { outline-color: transparent; } }
  aside {
    grid-area: chat;
    border-left: 1px solid var(--border);
    overflow-y: auto;
    padding: 12px;
  }
  aside h2 { margin: 0 0 8px; font-size: 13px; color: var(--muted); text-transform: uppercase; }
  .msg { margin: 3px 0; overflow-wrap: anywhere; }
  .sender { color: var(--accent); font-weight: 600; }
  .empty { color: var(--muted); font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>Батат</h1>
  <span>connected to <span class="channel" id="channel">…</span></span>
</header>
<main id="topics"><p class="empty">No topics yet.</p></main>
<aside>
  <h2>Chat log</h2>
  <div id="chat"></div>
</aside>
<script>
  const channelEl = document.getElementById("channel");
  const topicsEl = document.getElementById("topics");
  const chatEl = document.getElementById("chat");

  function esc(text) {
    return text.replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[ch]);
  }

  function renderMessage(message) {
    return '<div class="msg"><span class="sender">' + esc(message.senderName) + '</span>: ' + esc(message.text) + '</div>';
  }

  function appendMessage(message) {
    const stick = chatEl.parentElement.scrollTop + chatEl.parentElement.clientHeight >= chatEl.parentElement.scrollHeight - 20;
    chatEl.insertAdjacentHTML("beforeend", renderMessage(message));
    while (chatEl.children.length > 200) chatEl.firstChild.remove();
    if (stick) chatEl.parentElement.scrollTop = chatEl.parentElement.scrollHeight;
  }

  const seenIds = new Set();

  function renderTopics(topicList, flashNew) {
    if (topicList.length === 0) {
      topicsEl.innerHTML = '<p class="empty">No topics yet.</p>';
      return;
    }
    topicsEl.innerHTML = topicList.map((topic) => {
      const unimportant = topic.label !== null;
      const heading = topic.title ?? "";
      const badges =
        (topic.status !== "confirmed" ? '<span class="badge status-' + topic.status + '">' + topic.status + '</span>' : "") +
        (unimportant ? '<span class="badge">' + esc(topic.label) + '</span>' : "");
      const count = '<span class="count">' + topic.messages.length + '</span>';
      const items = topic.messages.map((message) => {
        const fresh = flashNew && !seenIds.has(message.id);
        seenIds.add(message.id);
        return '<li' + (fresh ? ' class="flash"' : "") + '><span class="sender">' + esc(message.senderName) + '</span>: ' + esc(message.text) + '</li>';
      }).join("");
      const classes = "card" + (unimportant ? " unimportant" : "") + (topic.status === "candidate" ? " candidate" : "");
      return '<div class="' + classes + '"><h2>' + esc(heading) + badges + count + '</h2><ul>' + items + '</ul></div>';
    }).join("");
  }

  const source = new EventSource("/events");
  source.addEventListener("init", (event) => {
    const init = JSON.parse(event.data);
    channelEl.textContent = init.channel;
    chatEl.innerHTML = init.chatLog.map(renderMessage).join("");
    chatEl.parentElement.scrollTop = chatEl.parentElement.scrollHeight;
    renderTopics(init.topics, false);
  });
  source.addEventListener("message", (event) => appendMessage(JSON.parse(event.data)));
  source.addEventListener("topics", (event) => renderTopics(JSON.parse(event.data), true));
</script>
</body>
</html>
`;
