import assert from "node:assert/strict";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, test } from "node:test";

import { topic_infer, topics, topics_reset, type ProcessedMessage } from "./topic.ts";

const ENVIRONMENT = [
  "LLAMA_RETRIES",
  "LLAMA_SERVER_URL",
  "TOPIC_AFFINITY_THRESHOLD",
  "TOPIC_CENTROID_ALPHA",
  "TOPIC_COHERENCE_THRESHOLD",
] as const;
const realEnvironment = new Map(ENVIRONMENT.map((name) => [name, process.env[name]]));
const realFetch = globalThis.fetch;
let messageId = 0;

beforeEach(() => {
  topics_reset();
  process.env.LLAMA_RETRIES = "0";
  process.env.LLAMA_SERVER_URL = "http://llama.test:9000";
  delete process.env.TOPIC_AFFINITY_THRESHOLD;
  delete process.env.TOPIC_CENTROID_ALPHA;
  delete process.env.TOPIC_COHERENCE_THRESHOLD;
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

test("message above threshold joins the topic and nudges the centroid by alpha", () => {
  topic_infer(message("first", [1, 0]));
  topic_infer(message("second", [0.6, 0.8]));

  assert.equal(topics().length, 1);
  const topic = topics()[0]!;
  assert.equal(topic.messages.length, 2);
  const mixed = [0.9 * 1 + 0.1 * 0.6, 0.9 * 0 + 0.1 * 0.8];
  const norm = Math.hypot(mixed[0]!, mixed[1]!);
  assert.ok(Math.abs(topic.vec_centroid[0]! - mixed[0]! / norm) < 1e-12);
  assert.ok(Math.abs(topic.vec_centroid[1]! - mixed[1]! / norm) < 1e-12);
});

test("centroid alpha is configurable and validated", () => {
  process.env.TOPIC_CENTROID_ALPHA = "0.5";
  topic_infer(message("first", [1, 0]));
  topic_infer(message("second", [0.6, 0.8]));

  const centroid = topics()[0]!.vec_centroid;
  const expected = [2 / Math.sqrt(5), 1 / Math.sqrt(5)];
  assert.ok(Math.abs(centroid[0]! - expected[0]!) < 1e-12);
  assert.ok(Math.abs(centroid[1]! - expected[1]!) < 1e-12);

  process.env.TOPIC_CENTROID_ALPHA = "1";
  assert.throws(() => topic_infer(message("bad", [1, 0])), /Invalid TOPIC_CENTROID_ALPHA/);
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

test("candidate reaching 5 messages is named directly (classifier bypassed)", async () => {
  const calls = mockLlama(["Speedrun strats"]);
  for (let index = 0; index < 5; index++) {
    topic_infer(message(`strats ${index}`, [1, 0]));
  }
  await settle();

  assert.equal(calls(), 1);
  assert.equal(topics().length, 1);
  assert.equal(topics()[0]!.status, "confirmed");
  assert.equal(topics()[0]!.title, "Speedrun strats");
  assert.equal(topics()[0]!.label, null);
});

function angle(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  return [Math.cos(radians), Math.sin(radians)];
}

test("coherent topic passes the periodic check unchanged", () => {
  for (let index = 0; index < 4; index++) {
    topic_infer(message(`same ${index}`, [1, 0]));
  }
  assert.equal(topics().length, 1);
  assert.equal(topics()[0]!.messages.length, 4);
  assert.deepEqual(topics()[0]!.vec_centroid, [1, 0]);
});

test("drifted topic is regenerated from recent messages and re-titled", async () => {
  process.env.TOPIC_AFFINITY_THRESHOLD = "0.1";
  process.env.TOPIC_CENTROID_ALPHA = "0.9";
  const calls = mockLlama(["Old title", "New title"]);

  for (let index = 0; index < 5; index++) {
    topic_infer(message(`start ${index}`, angle(0)));
  }
  await settle();
  assert.equal(topics()[0]!.title, "Old title");

  topic_infer(message("drift 1", angle(60)));
  topic_infer(message("drift 2", angle(120)));
  topic_infer(message("drift 3", angle(180)));
  await settle();

  assert.equal(calls(), 2);
  assert.equal(topics().length, 1);
  const topic = topics()[0]!;
  assert.equal(topic.status, "confirmed");
  assert.equal(topic.title, "New title");
  assert.equal(topic.messages.length, 5);
  assert.equal(topic.messages[0]!.text, "start 3");
  assert.equal(topic.messages[4]!.text, "drift 3");
  const expected = angle(60);
  assert.ok(Math.abs(topic.vec_centroid[0]! - expected[0]!) < 1e-12);
  assert.ok(Math.abs(topic.vec_centroid[1]! - expected[1]!) < 1e-12);
});

test("coherence threshold is validated", () => {
  process.env.TOPIC_COHERENCE_THRESHOLD = "0";
  for (let index = 0; index < 3; index++) {
    topic_infer(message(`ok ${index}`, [1, 0]));
  }
  assert.throws(() => topic_infer(message("fourth", [1, 0])), /Invalid TOPIC_COHERENCE_THRESHOLD/);
});

test("naming failure reverts to candidate and retries on the next message", async () => {
  mockLlama([new Response("busy", { status: 503 })]);
  for (let index = 0; index < 5; index++) {
    topic_infer(message(`flaky ${index}`, [1, 0]));
  }
  await settle();
  assert.equal(topics()[0]!.status, "candidate");
  assert.equal(topics()[0]!.title, null);

  mockLlama(["Recovered topic"]);
  topic_infer(message("retry", [1, 0]));
  await settle();
  assert.equal(topics()[0]!.status, "confirmed");
  assert.equal(topics()[0]!.title, "Recovered topic");
});
