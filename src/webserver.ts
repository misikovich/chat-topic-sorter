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
  vec_centroid: readonly number[];
  messages: ReadonlyArray<MessageView & Readonly<{ vec: readonly number[] }>>;
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
      vec_centroid: topic.vec_centroid,
      messages: topic.messages.map((message) => ({ ...messageView(message), vec: message.vec })),
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
    grid-template-columns: repeat(2, minmax(0, 1fr));
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
  .row-index { color: var(--muted); display: inline-block; min-width: 2em; }
  .copy-vector {
    margin-left: 6px;
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .copy-vector:hover { border-color: var(--accent); color: var(--text); }
  .heatmap { margin: 8px 0; }
  .heatmap-scroll { overflow-x: auto; }
  .heatmap canvas { display: block; image-rendering: pixelated; }
  .heatmap-legend {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr auto;
    gap: 8px;
    margin: 4px 0 0 28px;
    color: var(--muted);
    font-size: 10px;
  }
  .heatmap-legend span:nth-child(2) { text-align: center; }
  .heatmap-legend span:nth-child(3) { text-align: right; }
  .heatmap-gradient {
    height: 4px;
    margin-left: 28px;
    background: linear-gradient(90deg, #38bdf8, var(--panel), #f97350);
  }
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
  @media (max-width: 700px) {
    body {
      height: auto;
      min-height: 100vh;
      grid-template-rows: auto auto auto;
      grid-template-columns: minmax(0, 1fr);
      grid-template-areas: "header" "topics" "chat";
    }
    main { overflow-y: visible; grid-template-columns: minmax(0, 1fr); }
    aside { border-top: 1px solid var(--border); border-left: 0; max-height: 40vh; }
  }
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
  let renderedTopics = [];

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

  function topicScale(topic) {
    let max = 0;
    for (const value of topic.vec_centroid) max = Math.max(max, Math.abs(value));
    for (const message of topic.messages) {
      for (const value of message.vec) max = Math.max(max, Math.abs(value));
    }
    return max || 1;
  }

  function heatColor(value, scale) {
    const intensity = Math.min(1, Math.abs(value) / scale);
    const target = value < 0 ? [56, 189, 248] : [249, 115, 80];
    return "rgb(" + target.map((channel, index) => Math.round([23, 23, 29][index] + (channel - [23, 23, 29][index]) * intensity)).join(",") + ")";
  }

  function drawHeatmap(canvas, topic, scale) {
    const vectors = [topic.vec_centroid].concat(topic.messages.map((message) => message.vec));
    const labelWidth = 28;
    const rowHeight = 12;
    canvas.width = labelWidth + topic.vec_centroid.length;
    canvas.height = vectors.length * rowHeight;
    const context = canvas.getContext("2d");
    context.font = "10px system-ui, sans-serif";
    context.textAlign = "right";
    context.textBaseline = "middle";
    vectors.forEach((vector, row) => {
      context.fillStyle = "#8a8a96";
      context.fillText(row === 0 ? "C" : String(row), labelWidth - 5, row * rowHeight + rowHeight / 2);
      vector.forEach((value, dimension) => {
        context.fillStyle = heatColor(value, scale);
        context.fillRect(labelWidth + dimension, row * rowHeight, 1, rowHeight);
      });
    });
  }

  function renderTopics(topicList, flashNew) {
    renderedTopics = topicList;
    if (topicList.length === 0) {
      topicsEl.innerHTML = '<p class="empty">No topics yet.</p>';
      return;
    }
    const scales = topicList.map(topicScale);
    topicsEl.innerHTML = topicList.map((topic, topicIndex) => {
      const unimportant = topic.label !== null;
      const heading = topic.title ?? "";
      const badges =
        (topic.status !== "confirmed" ? '<span class="badge status-' + topic.status + '">' + topic.status + '</span>' : "") +
        (unimportant ? '<span class="badge">' + esc(topic.label) + '</span>' : "");
      const count = '<span class="count">' + topic.messages.length + '</span>';
      const centroidCopy = '<button type="button" class="copy-vector" data-topic="' + topicIndex + '" data-message="-1" aria-label="Copy centroid vector as JSON">copy C</button>';
      const scale = scales[topicIndex];
      const scaleText = scale.toPrecision(3);
      const dimensions = topic.vec_centroid.length;
      const heatmap = '<div class="heatmap"><div class="heatmap-scroll"><canvas data-topic="' + topicIndex + '" aria-label="Embedding heatmap"></canvas><div class="heatmap-gradient" style="width:' + dimensions + 'px"></div><div class="heatmap-legend" style="width:' + dimensions + 'px"><span>-' + scaleText + '</span><span>0</span><span>+' + scaleText + '</span><span>dims 0-' + (dimensions - 1) + '</span></div></div></div>';
      const items = topic.messages.map((message, messageIndex) => {
        const fresh = flashNew && !seenIds.has(message.id);
        seenIds.add(message.id);
        return '<li' + (fresh ? ' class="flash"' : "") + '><span class="row-index">' + (messageIndex + 1) + '</span><span class="sender">' + esc(message.senderName) + '</span>: ' + esc(message.text) + '<button type="button" class="copy-vector" data-topic="' + topicIndex + '" data-message="' + messageIndex + '" aria-label="Copy message vector as JSON">copy vec</button></li>';
      }).join("");
      const classes = "card" + (unimportant ? " unimportant" : "") + (topic.status === "candidate" ? " candidate" : "");
      return '<div class="' + classes + '"><h2>' + esc(heading) + badges + centroidCopy + count + '</h2>' + heatmap + '<ul>' + items + '</ul></div>';
    }).join("");
    topicsEl.querySelectorAll("canvas[data-topic]").forEach((canvas) => {
      const topicIndex = Number(canvas.dataset.topic);
      drawHeatmap(canvas, topicList[topicIndex], scales[topicIndex]);
    });
  }

  topicsEl.addEventListener("click", async (event) => {
    const button = event.target.closest("button.copy-vector");
    if (button === null) return;
    const topic = renderedTopics[Number(button.dataset.topic)];
    const messageIndex = Number(button.dataset.message);
    const vector = messageIndex < 0 ? topic.vec_centroid : topic.messages[messageIndex].vec;
    try {
      await navigator.clipboard.writeText(JSON.stringify(vector));
      button.textContent = "copied";
    } catch {
      button.textContent = "copy failed";
    }
    setTimeout(() => { button.textContent = messageIndex < 0 ? "copy C" : "copy vec"; }, 1200);
  });

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
