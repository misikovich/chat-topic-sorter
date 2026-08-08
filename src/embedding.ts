import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { messageVerify } from "./utils.ts";

const LOGTAG = "[EMBEDDING]";
const DEFAULT_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
const DEFAULT_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41";
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_PORT = 8_091;
const DEFAULT_TIMEOUT_SECONDS = 900;
const NORMALIZATION_TOLERANCE = 1e-2;

type EmbeddingConfig = {
  model: string;
  revision: string;
  dimensions: number;
  port: number;
  timeoutMilliseconds: number;
  apiKey: string | undefined;
};

let ownedServer: ChildProcess | undefined;
let startup: Promise<void> | undefined;

process.once("exit", () => ownedServer?.kill());

function integer(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const text = process.env[name]?.trim() || String(fallback);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`Invalid ${name}: ${text}`);
  }
  return value;
}

function config(): EmbeddingConfig {
  const timeoutText = process.env.EMBEDDING_INFERENCE_TIMEOUT_SECONDS?.trim()
    || String(DEFAULT_TIMEOUT_SECONDS);
  const timeoutSeconds = Number(timeoutText);
  const timeoutMilliseconds = Math.ceil(timeoutSeconds * 1_000);
  if (
    !Number.isFinite(timeoutSeconds)
    || timeoutSeconds <= 0
    || !Number.isSafeInteger(timeoutMilliseconds)
    || timeoutMilliseconds > 2_147_483_647
  ) {
    throw new Error(`Invalid EMBEDDING_INFERENCE_TIMEOUT_SECONDS: ${timeoutText}`);
  }
  return {
    model: process.env.EMBEDDING_MODEL_ID?.trim() || DEFAULT_MODEL,
    revision: process.env.EMBEDDING_MODEL_REVISION?.trim() || DEFAULT_REVISION,
    dimensions: integer("EMBEDDING_DIMENSIONS", DEFAULT_DIMENSIONS),
    port: integer("EMBEDDING_PORT", DEFAULT_PORT, 65_535),
    timeoutMilliseconds,
    apiKey: process.env.EMBEDDING_API_KEY?.trim() || undefined,
  };
}

function endpoint(configuration: EmbeddingConfig, path: string): URL {
  return new URL(path, `http://127.0.0.1:${configuration.port}`);
}

async function available(url: URL, timeoutMilliseconds: number, stopped?: AbortSignal): Promise<boolean> {
  try {
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(1_000, timeoutMilliseconds)));
    const signal = stopped === undefined ? timeout : AbortSignal.any([stopped, timeout]);
    return (await fetch(url, { signal })).ok;
  } catch {
    return false;
  }
}

async function waitUntilReady(child: ChildProcess, configuration: EmbeddingConfig): Promise<void> {
  const controller = new AbortController();
  const deadline = Date.now() + configuration.timeoutMilliseconds;
  let onError: (cause: Error) => void;
  let onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    onError = (cause) => reject(new Error(`Failed to start embedding server: ${cause.message}`));
    onExit = (code, signal) => reject(new Error(
      `Embedding server exited before becoming ready (${signal ?? code ?? "unknown"})`,
    ));
    child.once("error", onError);
    child.once("exit", onExit);
  });
  const ready = (async (): Promise<void> => {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (await available(endpoint(configuration, "/readyz"), remaining, controller.signal)) return;
      await delay(Math.min(100, Math.max(1, remaining)), undefined, { signal: controller.signal });
    }
    throw new Error(
      `Embedding server was not ready after ${configuration.timeoutMilliseconds / 1_000} seconds`,
    );
  })();

  try {
    await Promise.race([ready, stopped]);
  } finally {
    controller.abort();
    child.off("error", onError!);
    child.off("exit", onExit!);
  }
}

async function startServer(configuration: EmbeddingConfig): Promise<void> {
  if (await available(endpoint(configuration, "/healthz"), 1_000)) {
    console.info(LOGTAG, "reusing embedding server", { port: configuration.port });
    return;
  }

  console.info(LOGTAG, "starting embedding server", { port: configuration.port });
  let child: ChildProcess;
  try {
    child = spawn("uv", ["run", "embedding-server", "--preload"], {
      cwd: new URL("../embedding-server/", import.meta.url),
      env: {
        ...process.env,
        EMBEDDING_HOST: "127.0.0.1",
        EMBEDDING_PORT: String(configuration.port),
        EMBEDDING_MODEL_ID: configuration.model,
        EMBEDDING_MODEL_REVISION: configuration.revision,
        EMBEDDING_DIMENSIONS: String(configuration.dimensions),
      },
      stdio: "inherit",
    });
  } catch (cause) {
    throw new Error(`Failed to start embedding server: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  ownedServer = child;
  const reset = (): void => {
    if (ownedServer !== child) return;
    ownedServer = undefined;
    startup = undefined;
  };
  child.once("error", (cause) => {
    console.error(LOGTAG, "embedding server process error", cause.message);
    reset();
  });
  child.once("exit", (code, signal) => {
    console.info(LOGTAG, "embedding server stopped", { code, signal });
    reset();
  });
  child.unref();

  try {
    await waitUntilReady(child, configuration);
  } catch (cause) {
    if (ownedServer === child) {
      ownedServer = undefined;
      child.kill();
    }
    throw cause;
  }
  console.info(LOGTAG, "embedding server ready", { port: configuration.port });
}

function ensureServer(configuration: EmbeddingConfig): Promise<void> {
  if (startup === undefined) {
    const pending = startServer(configuration).catch((cause: unknown) => {
      if (startup === pending) startup = undefined;
      throw cause;
    });
    startup = pending;
  }
  return startup;
}

function parseVector(text: string, configuration: EmbeddingConfig): number[] {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("Malformed embedding response: invalid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Malformed embedding response");
  }
  const response = body as Record<string, unknown>;
  if (response.model !== configuration.model) {
    throw new Error(`Unexpected embedding model: ${String(response.model)}`);
  }
  if (response.model_revision !== configuration.revision) {
    throw new Error(`Unexpected embedding model revision: ${String(response.model_revision)}`);
  }
  if (!Array.isArray(response.data) || response.data.length !== 1) {
    throw new Error("Malformed embedding response: expected exactly one vector");
  }
  const row = response.data[0];
  if (typeof row !== "object" || row === null || Array.isArray(row) || (row as Record<string, unknown>).index !== 0) {
    throw new Error("Malformed embedding response: expected vector index 0");
  }
  const embedding = (row as Record<string, unknown>).embedding;
  if (!Array.isArray(embedding) || embedding.length !== configuration.dimensions) {
    throw new Error(`Malformed embedding response: expected ${configuration.dimensions} dimensions`);
  }

  let squaredNorm = 0;
  const vector = embedding.map((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("Malformed embedding response: vector values must be finite numbers");
    }
    squaredNorm += value * value;
    return value;
  });
  const norm = Math.sqrt(squaredNorm);
  if (Math.abs(norm - 1) > NORMALIZATION_TOLERANCE) {
    throw new Error(`Malformed embedding response: vector is not normalized (norm=${norm.toFixed(6)})`);
  }
  return vector;
}

async function fetchEmbedding(message: string, configuration: EmbeddingConfig): Promise<string> {
  await ensureServer(configuration);
  const signal = AbortSignal.timeout(configuration.timeoutMilliseconds);
  let response: Response;
  let text: string;
  
  try {
    response = await fetch(endpoint(configuration, "/v1/embeddings"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(configuration.apiKey === undefined
          ? {}
          : { Authorization: `Bearer ${configuration.apiKey}` }),
      },
      body: JSON.stringify({
        model: configuration.model,
        input_type: "document",
        encoding_format: "float",
        dimensions: configuration.dimensions,
        input: message,
      }),
      signal,
    });
    text = await response.text();
  } catch (cause) {
    startup = undefined;
    if (signal.aborted) {
      throw new Error(`Embedding request timed out after ${configuration.timeoutMilliseconds / 1_000} seconds`);
    }
    throw new Error(`Embedding request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!response.ok) {
    throw new Error(`Embedding request failed (${response.status}): ${text.trim() || response.statusText}`);
  }
  return text;
}

export async function vectorize(message: string): Promise<number[]> {
  messageVerify(message);
  const conf = config();

  const time = performance.now();
  
  const resp = await fetchEmbedding(message, conf);
  const vect = parseVector(resp, conf);

  const took = performance.now() - time;
  console.debug(LOGTAG, took, message.slice(0, 5), "vectorize() ->", vect.slice(0, 5));
  return vect;
}
