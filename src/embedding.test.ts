import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import process from "node:process";
import { afterEach, beforeEach, mock, test } from "node:test";

const MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41";
const DIMENSIONS = 384;
const ENVIRONMENT = [
  "EMBEDDING_API_KEY",
  "EMBEDDING_DIMENSIONS",
  "EMBEDDING_INFERENCE_TIMEOUT_SECONDS",
  "EMBEDDING_MODEL_ID",
  "EMBEDDING_MODEL_REVISION",
  "EMBEDDING_PORT",
] as const;
const realEnvironment = new Map(ENVIRONMENT.map((name) => [name, process.env[name]]));
const realFetch = globalThis.fetch;
const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");
const unitVector = [1, ...Array<number>(DIMENSIONS - 1).fill(0)];
let importId = 0;

beforeEach(() => {
  process.env.EMBEDDING_API_KEY = "test-key";
  process.env.EMBEDDING_DIMENSIONS = String(DIMENSIONS);
  process.env.EMBEDDING_INFERENCE_TIMEOUT_SECONDS = "1";
  process.env.EMBEDDING_MODEL_ID = MODEL;
  process.env.EMBEDDING_MODEL_REVISION = REVISION;
  process.env.EMBEDDING_PORT = "8091";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  mock.restoreAll();
  syncBuiltinESMExports();
  for (const [name, value] of realEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function embeddingModule(): Promise<typeof import("./embedding.ts")> {
  const url = new URL(`./embedding.ts?test=${importId++}`, import.meta.url);
  return await import(url.href) as typeof import("./embedding.ts");
}

function embeddingResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: "list",
    model: MODEL,
    model_revision: REVISION,
    data: [{ object: "embedding", index: 0, embedding: unitVector }],
    usage: { prompt_tokens: 2, total_tokens: 2 },
    ...overrides,
  };
}

function fakeChild(): {
  child: ChildProcess;
  kill: ReturnType<typeof mock.fn>;
  unref: ReturnType<typeof mock.fn>;
} {
  const child = new EventEmitter() as ChildProcess;
  const kill = mock.fn(() => true);
  const unref = mock.fn(() => undefined);
  Object.assign(child, { exitCode: null, signalCode: null, kill, unref });
  return { child, kill, unref };
}

function mockSpawn(implementation: (...args: unknown[]) => ChildProcess): ReturnType<typeof mock.method> {
  const mocked = mock.method(
    childProcess,
    "spawn",
    implementation as typeof childProcess.spawn,
  );
  syncBuiltinESMExports();
  return mocked;
}

test("embedding validates input and configuration before startup", async () => {
  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => {
    calls++;
    return Response.json({});
  }) as typeof fetch;
  const { vectorize } = await embeddingModule();

  await assert.rejects(vectorize(" "), /non-blank string/);
  await assert.rejects(vectorize(42 as unknown as string), /non-blank string/);
  process.env.EMBEDDING_PORT = "0";
  await assert.rejects(vectorize("hello"), /Invalid EMBEDDING_PORT/);
  process.env.EMBEDDING_PORT = "8091";
  process.env.EMBEDDING_DIMENSIONS = "nope";
  await assert.rejects(vectorize("hello"), /Invalid EMBEDDING_DIMENSIONS/);
  process.env.EMBEDDING_DIMENSIONS = String(DIMENSIONS);
  process.env.EMBEDDING_INFERENCE_TIMEOUT_SECONDS = "0";
  await assert.rejects(vectorize("hello"), /Invalid EMBEDDING_INFERENCE_TIMEOUT_SECONDS/);
  assert.equal(calls, 0);
});

test("embedding starts once for concurrent calls and restarts after exit", async () => {
  const first = fakeChild();
  const second = fakeChild();
  const children = [first.child, second.child];
  const spawn = mockSpawn(() => children.shift()!);
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/healthz")) throw new Error("offline");
    if (url.endsWith("/readyz")) return Response.json({ ready: true });
    requests.push({ url, init });
    return Response.json(embeddingResponse());
  }) as typeof fetch;
  const { vectorize } = await embeddingModule();

  const [alpha, beta] = await Promise.all([vectorize("alpha"), vectorize("beta")]);
  assert.deepEqual(alpha, unitVector);
  assert.deepEqual(beta, unitVector);
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(first.unref.mock.callCount(), 1);

  const [command, args, options] = spawn.mock.calls[0]!.arguments as [string, string[], SpawnOptions];
  assert.equal(command, "uv");
  assert.deepEqual(args, ["run", "embedding-server", "--preload"]);
  assert.equal(String(options.cwd), new URL("../embedding-server/", import.meta.url).href);
  assert.equal(options.stdio, "inherit");
  assert.equal(options.env?.EMBEDDING_HOST, "127.0.0.1");
  assert.equal(options.env?.EMBEDDING_PORT, "8091");
  assert.equal(options.env?.EMBEDDING_MODEL_ID, MODEL);
  assert.equal(options.env?.EMBEDDING_MODEL_REVISION, REVISION);
  assert.equal(options.env?.EMBEDDING_DIMENSIONS, String(DIMENSIONS));

  assert.deepEqual(requests.map(({ url }) => url), [
    "http://127.0.0.1:8091/v1/embeddings",
    "http://127.0.0.1:8091/v1/embeddings",
  ]);
  assert.deepEqual(JSON.parse(String(requests[0]!.init?.body)), {
    model: MODEL,
    input_type: "document",
    encoding_format: "float",
    dimensions: DIMENSIONS,
    input: "alpha",
  });
  assert.deepEqual(requests[0]!.init?.headers, {
    "Content-Type": "application/json",
    Authorization: "Bearer test-key",
  });

  first.child.emit("exit", 1, null);
  assert.deepEqual(await vectorize("gamma"), unitVector);
  assert.equal(spawn.mock.callCount(), 2);
  assert.equal(second.unref.mock.callCount(), 1);
});

test("embedding reuses a healthy server and retries startup after a network failure", async () => {
  const spawn = mockSpawn(() => {
    throw new Error("spawn must not be called");
  });
  delete process.env.EMBEDDING_API_KEY;
  let healthChecks = 0;
  let embeddingCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/healthz")) {
      healthChecks++;
      return Response.json({ status: "ok" });
    }
    embeddingCalls++;
    if (embeddingCalls === 2) throw new Error("connection lost");
    assert.deepEqual(init?.headers, { "Content-Type": "application/json" });
    return Response.json(embeddingResponse());
  }) as typeof fetch;
  const { vectorize } = await embeddingModule();

  assert.deepEqual(await vectorize("one"), unitVector);
  await assert.rejects(vectorize("two"), /Embedding request failed: connection lost/);
  assert.deepEqual(await vectorize("three"), unitVector);
  assert.equal(healthChecks, 2);
  assert.equal(spawn.mock.callCount(), 0);
});

test("embedding rejects HTTP and malformed vector responses", async () => {
  const responses = [
    new Response("busy", { status: 503 }),
    new Response("{"),
    Response.json(embeddingResponse({ data: [] })),
    Response.json(embeddingResponse({ data: [
      { index: 0, embedding: unitVector },
      { index: 1, embedding: unitVector },
    ] })),
    Response.json(embeddingResponse({ model: "other/model" })),
    Response.json(embeddingResponse({ model_revision: "other-revision" })),
    Response.json(embeddingResponse({ data: [{ index: 1, embedding: unitVector }] })),
    Response.json(embeddingResponse({ data: [{ index: 0, embedding: unitVector.slice(1) }] })),
    Response.json(embeddingResponse({ data: [{ index: 0, embedding: [null, ...unitVector.slice(1)] }] })),
    Response.json(embeddingResponse({ data: [{ index: 0, embedding: [2, ...unitVector.slice(1)] }] })),
  ];
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => (
    String(input).endsWith("/healthz")
      ? Response.json({ status: "ok" })
      : responses.shift()!
  )) as typeof fetch;
  const { vectorize } = await embeddingModule();

  await assert.rejects(vectorize("message"), /request failed \(503\): busy/);
  await assert.rejects(vectorize("message"), /invalid JSON/);
  await assert.rejects(vectorize("message"), /exactly one vector/);
  await assert.rejects(vectorize("message"), /exactly one vector/);
  await assert.rejects(vectorize("message"), /Unexpected embedding model/);
  await assert.rejects(vectorize("message"), /Unexpected embedding model revision/);
  await assert.rejects(vectorize("message"), /vector index 0/);
  await assert.rejects(vectorize("message"), /expected 384 dimensions/);
  await assert.rejects(vectorize("message"), /finite numbers/);
  await assert.rejects(vectorize("message"), /not normalized/);
  assert.equal(responses.length, 0);
});

test("embedding reports spawn, premature-exit, and readiness failures", async () => {
  const exited = fakeChild();
  const timedOut = fakeChild();
  let spawnCalls = 0;
  mockSpawn(() => {
    spawnCalls++;
    if (spawnCalls === 1) throw new Error("spawn blocked");
    if (spawnCalls === 2) {
      queueMicrotask(() => exited.child.emit("exit", 7, null));
      return exited.child;
    }
    return timedOut.child;
  });
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    if (String(input).endsWith("/healthz")) throw new Error("offline");
    return Response.json({ ready: false }, { status: 503 });
  }) as typeof fetch;
  process.env.EMBEDDING_INFERENCE_TIMEOUT_SECONDS = "0.01";
  const { vectorize } = await embeddingModule();

  await assert.rejects(vectorize("one"), /Failed to start embedding server: spawn blocked/);
  await assert.rejects(vectorize("two"), /exited before becoming ready \(7\)/);
  await assert.rejects(vectorize("three"), /was not ready after 0.01 seconds/);
  assert.equal(timedOut.kill.mock.callCount(), 1);
});
