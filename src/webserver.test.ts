import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import type { ChatMessage } from "./chatbot.ts";
import { topic_infer, topics_reset } from "./topic.ts";
import { web_message, web_start, web_stop, web_topic_views } from "./webserver.ts";

let messageId = 0;

beforeEach(() => {
  topics_reset();
});

afterEach(() => {
  web_stop();
});

function message(text: string): ChatMessage {
  const id = String(messageId++);
  return { id, channelId: "channel", senderId: "sender", senderName: "sender", text };
}

async function start(): Promise<number> {
  return web_start({ port: 0, channel: "testchannel" });
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>, event: string): Promise<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for (let round = 0; round < 20; round++) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const match = buffer.match(new RegExp(`event: ${event}\\ndata: (.*)\\n\\n`));
    if (match) return JSON.parse(match[1]!);
  }
  throw new Error(`Event not received: ${event}`);
}

test("GET / serves the dashboard page", async () => {
  const port = await start();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await response.text(), /Twitch Chat Topic Sorter/);
});

test("unknown path returns 404", async () => {
  const port = await start();
  const response = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(response.status, 404);
});

test("init event carries channel, chat log and vec-free topics", async () => {
  const port = await start();
  web_message(message("hello"));
  topic_infer({ ...message("topical"), vec: [1, 0] });

  const response = await fetch(`http://127.0.0.1:${port}/events`);
  const reader = response.body!.getReader();
  const init = await readEvent(reader, "init") as {
    channel: string;
    chatLog: Array<Record<string, unknown>>;
    topics: Array<{ messages: Array<Record<string, unknown>> }>;
  };
  await reader.cancel();

  assert.equal(init.channel, "testchannel");
  assert.equal(init.chatLog.length, 1);
  assert.equal(init.chatLog[0]!.text, "hello");
  assert.equal(init.topics.length, 1);
  assert.ok(!("vec" in init.topics[0]!.messages[0]!));
});

test("web_message broadcasts to connected clients", async () => {
  const port = await start();
  const response = await fetch(`http://127.0.0.1:${port}/events`);
  const reader = response.body!.getReader();
  await readEvent(reader, "init");

  web_message(message("broadcast me"));
  const received = await readEvent(reader, "message") as { text: string };
  await reader.cancel();

  assert.equal(received.text, "broadcast me");
});

test("web_topic_views strips vectors", () => {
  topic_infer({ ...message("first"), vec: [1, 0] });
  const views = web_topic_views();
  assert.equal(views.length, 1);
  assert.ok(!("vec_centroid" in views[0]!));
  assert.ok(!("vec" in views[0]!.messages[0]!));
  assert.equal(views[0]!.status, "candidate");
  assert.equal(views[0]!.label, null);
});

test("web_topic_views sorts topics by message count descending", () => {
  topic_infer({ ...message("lonely"), vec: [1, 0] });
  topic_infer({ ...message("popular 1"), vec: [0, 1] });
  topic_infer({ ...message("popular 2"), vec: [0, 1] });

  const views = web_topic_views();
  assert.equal(views.length, 2);
  assert.equal(views[0]!.messages.length, 2);
  assert.equal(views[0]!.messages[0]!.text, "popular 1");
  assert.equal(views[1]!.messages.length, 1);
});

test("chat log is capped", async () => {
  const port = await start();
  for (let index = 0; index < 250; index++) web_message(message(`msg ${index}`));

  const response = await fetch(`http://127.0.0.1:${port}/events`);
  const reader = response.body!.getReader();
  const init = await readEvent(reader, "init") as { chatLog: Array<{ text: string }> };
  await reader.cancel();

  assert.equal(init.chatLog.length, 200);
  assert.equal(init.chatLog[0]!.text, "msg 50");
  assert.equal(init.chatLog[199]!.text, "msg 249");
});
