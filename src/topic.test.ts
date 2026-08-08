import assert from "node:assert/strict";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, test } from "node:test";

import { topic_infer, topics, topics_reset, type ProcessedMessage } from "./topic.ts";

const ENVIRONMENT = ["LLAMA_RETRIES", "LLAMA_SERVER_URL", "TOPIC_AFFINITY_THRESHOLD"] as const;
const realEnvironment = new Map(ENVIRONMENT.map((name) => [name, process.env[name]]));
const realFetch = globalThis.fetch;
let messageId = 0;

beforeEach(() => {
  topics_reset();
  process.env.LLAMA_RETRIES = "0";
  process.env.LLAMA_SERVER_URL = "http://llama.test:9000";
  delete process.env.TOPIC_AFFINITY_THRESHOLD;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of realEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function message(text: string, vec: number[]): ProcessedMessage {
  const id = String(messageId++);
  return { id, channelId: "channel", senderId: "sender", senderName: "sender", text, vec };
}

function basis(index: number, dimensions: number): number[] {
  const vec = Array<number>(dimensions).fill(0);
  vec[index] = 1;
  return vec;
}

function mockLlama(outputs: Array<string | Response>): () => number {
  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    const output = outputs[calls++];
    if (output === undefined) throw new Error("Unexpected llama request");
    if (output instanceof Response) return output;
    return Response.json({ choices: [{ message: { content: output } }] });
  }) as typeof fetch;
  return () => calls;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) await delay(0);
}

test("message above threshold joins the topic and updates the centroid", () => {
  topic_infer(message("first", [1, 0]));
  topic_infer(message("second", [0.6, 0.8]));

  assert.equal(topics().length, 1);
  const topic = topics()[0]!;
  assert.equal(topic.messages.length, 2);
  assert.deepEqual(topic.vec_sum, [1.6, 0.8]);
  const norm = Math.hypot(1.6, 0.8);
  assert.deepEqual(topic.vec_centroid, [1.6 / norm, 0.8 / norm]);
});

test("message below threshold creates a new candidate topic", () => {
  topic_infer(message("first", [1, 0]));
  topic_infer(message("unrelated", [0, 1]));

  assert.equal(topics().length, 2);
  assert.deepEqual(topics()[1]!.vec_centroid, [0, 1]);
  assert.equal(topics()[1]!.messages.length, 1);
});

test("threshold is configurable and validated", () => {
  process.env.TOPIC_AFFINITY_THRESHOLD = "0.9";
  topic_infer(message("first", [1, 0]));
  topic_infer(message("close", [0.8, 0.6]));
  assert.equal(topics().length, 2);

  process.env.TOPIC_AFFINITY_THRESHOLD = "2";
  assert.throws(() => topic_infer(message("bad", [1, 0])), /Invalid TOPIC_AFFINITY_THRESHOLD/);
});

test("candidate expires after 50 subsequent messages without reaching 5", () => {
  const dimensions = 52;
  topic_infer(message("stale", basis(0, dimensions)));
  for (let index = 1; index <= 49; index++) {
    topic_infer(message(`other ${index}`, basis(index, dimensions)));
  }
  assert.ok(topics().some((topic) => topic.messages[0]!.text === "stale"));

  topic_infer(message("last straw", basis(50, dimensions)));
  assert.ok(!topics().some((topic) => topic.messages[0]!.text === "stale"));
});

test("candidate reaching 5 messages is classified and named", async () => {
  const calls = mockLlama([":other:", "Speedrun strats"]);
  for (let index = 0; index < 5; index++) {
    topic_infer(message(`strats ${index}`, [1, 0]));
  }
  await settle();

  assert.equal(calls(), 2);
  assert.equal(topics().length, 1);
  assert.equal(topics()[0]!.status, "confirmed");
  assert.equal(topics()[0]!.title, "Speedrun strats");
});

test("candidate classified as unimportant is discarded", async () => {
  const calls = mockLlama([":greeting:"]);
  for (let index = 0; index < 5; index++) {
    topic_infer(message(`hi ${index}`, [1, 0]));
  }
  await settle();

  assert.equal(calls(), 1);
  assert.equal(topics().length, 0);
});

test("naming failure reverts to candidate and retries on the next message", async () => {
  mockLlama([new Response("busy", { status: 503 })]);
  for (let index = 0; index < 5; index++) {
    topic_infer(message(`flaky ${index}`, [1, 0]));
  }
  await settle();
  assert.equal(topics()[0]!.status, "candidate");
  assert.equal(topics()[0]!.title, null);

  mockLlama([":other:", "Recovered topic"]);
  topic_infer(message("retry", [1, 0]));
  await settle();
  assert.equal(topics()[0]!.status, "confirmed");
  assert.equal(topics()[0]!.title, "Recovered topic");
});
