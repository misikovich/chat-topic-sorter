import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";
import { afterEach, beforeEach, test } from "node:test";

import { llama_classify, llama_describe } from "./llama.ts";

const realFetch = globalThis.fetch;
const realServerUrl = process.env.LLAMA_SERVER_URL;
const realModel = process.env.LLAMA_MODEL;
const realRetries = process.env.LLAMA_RETRIES;
const realTimeoutSeconds = process.env.LLAMA_TIMEOUT_SECONDS;

beforeEach(() => {
  process.env.LLAMA_RETRIES = "0";
  process.env.LLAMA_TIMEOUT_SECONDS = "30";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realServerUrl === undefined) delete process.env.LLAMA_SERVER_URL;
  else process.env.LLAMA_SERVER_URL = realServerUrl;
  if (realModel === undefined) delete process.env.LLAMA_MODEL;
  else process.env.LLAMA_MODEL = realModel;
  if (realRetries === undefined) delete process.env.LLAMA_RETRIES;
  else process.env.LLAMA_RETRIES = realRetries;
  if (realTimeoutSeconds === undefined) delete process.env.LLAMA_TIMEOUT_SECONDS;
  else process.env.LLAMA_TIMEOUT_SECONDS = realTimeoutSeconds;
});

test("llama classifies and describes message batches", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const outputs = [":greeting:", "  A friendly welcome  "];
  process.env.LLAMA_SERVER_URL = "http://llama.test:9000";
  process.env.LLAMA_MODEL = "test-model";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return Response.json({ choices: [{ message: { content: outputs.shift() } }] });
  }) as typeof fetch;

  assert.equal(await llama_classify(["hello", "hi"]), "greeting");
  assert.equal(await llama_describe(["hello", "welcome!"]), "A friendly welcome");

  const classifierPrompt = readFileSync(
    new URL("../llama/classifier_system_prompt.txt", import.meta.url),
    "utf8",
  ).trim();
  const namegiverPrompt = readFileSync(
    new URL("../llama/namegiver_system_prompt.txt", import.meta.url),
    "utf8",
  ).trim();
  assert.deepEqual(calls, [
    {
      url: "http://llama.test:9000/v1/chat/completions",
      body: {
        model: "test-model",
        messages: [
          { role: "system", content: classifierPrompt },
          { role: "user", content: '["hello","hi"]' },
        ],
        temperature: 0,
        max_tokens: 16,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      },
    },
    {
      url: "http://llama.test:9000/v1/chat/completions",
      body: {
        model: "test-model",
        messages: [
          { role: "system", content: namegiverPrompt },
          { role: "user", content: '["hello","welcome!"]' },
        ],
        temperature: 0,
        max_tokens: 64,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      },
    },
  ]);
});

test("llama rejects invalid message batches before requesting", async () => {
  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls++;
    return Response.json({});
  }) as typeof fetch;

  await assert.rejects(llama_classify([]), /non-empty array/);
  await assert.rejects(llama_describe(["hello", " "]), /non-blank strings/);
  process.env.LLAMA_RETRIES = "-1";
  await assert.rejects(llama_describe(["hello"]), /Invalid LLAMA_RETRIES/);
  process.env.LLAMA_RETRIES = "0";
  process.env.LLAMA_TIMEOUT_SECONDS = "0";
  await assert.rejects(llama_describe(["hello"]), /Invalid LLAMA_TIMEOUT_SECONDS/);
  assert.equal(calls, 0);
});

test("llama retries unexpected output up to the configured limit", async () => {
  const outputs = [":unknown:", "not-a-class", ":laughter:"];
  let calls = 0;
  process.env.LLAMA_RETRIES = "2";
  globalThis.fetch = (async (): Promise<Response> => {
    calls++;
    return Response.json({ choices: [{ message: { content: outputs.shift() } }] });
  }) as typeof fetch;

  assert.equal(await llama_classify(["lol"]), "laughter");
  assert.equal(calls, 3);
});

test("llama retries requests that exceed the configured timeout", async () => {
  let calls = 0;
  process.env.LLAMA_RETRIES = "2";
  process.env.LLAMA_TIMEOUT_SECONDS = "0.01";
  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls++;
    if (calls === 3) return Response.json({ choices: [{ message: { content: "Recovered" } }] });
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;

  assert.equal(await llama_describe(["hello"]), "Recovered");
  assert.equal(calls, 3);
});

test("llama reports request failures", async () => {
  globalThis.fetch = (async (): Promise<Response> => new Response("server busy", { status: 503 })) as typeof fetch;
  await assert.rejects(llama_describe(["hello"]), /request failed \(503\): server busy/);

  globalThis.fetch = (async (): Promise<Response> => {
    throw new Error("offline");
  }) as typeof fetch;
  await assert.rejects(llama_describe(["hello"]), /request failed: offline/);
});

test("llama rejects malformed and empty responses", async () => {
  const responses = [
    new Response("{"),
    Response.json({ choices: [] }),
    Response.json({ choices: [{ message: { content: "   " } }] }),
  ];
  globalThis.fetch = (async (): Promise<Response> => responses.shift()!) as typeof fetch;

  await assert.rejects(llama_describe(["hello"]), /invalid JSON/);
  await assert.rejects(llama_describe(["hello"]), /missing completion content/);
  await assert.rejects(llama_describe(["hello"]), /empty completion/);
});

test("llama rejects classifications not declared in the prompt", async () => {
  globalThis.fetch = (async (): Promise<Response> => (
    Response.json({ choices: [{ message: { content: ":question:" } }] })
  )) as typeof fetch;

  await assert.rejects(llama_classify(["what happened?"]), /Unexpected llama.cpp classification: :question:/);
});
