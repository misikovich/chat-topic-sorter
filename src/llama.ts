import { readFileSync } from "node:fs";
import process from "node:process";

const LOGTAG = "[LLAMA]";
const CLASSIFIER_PROMPT = readFileSync(
  new URL("../llama/classifier_system_prompt.txt", import.meta.url),
  "utf8",
).trim();
const NAMEGIVER_PROMPT = readFileSync(
  new URL("../llama/namegiver_system_prompt.txt", import.meta.url),
  "utf8",
).trim();
const CLASSIFICATIONS = new Set(
  [...CLASSIFIER_PROMPT.matchAll(/^- :([^:\r\n]+):\s*$/gm)].map((match) => match[1]!),
);

if (CLASSIFICATIONS.size === 0) throw new Error("Classifier prompt defines no classifications");

type ChatCompletion = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

class RetryableLlamaError extends Error {}

function config(): { url: URL; model: string; retries: number; timeoutSeconds: number } {
  const serverUrl = process.env.LLAMA_SERVER_URL?.trim() || "http://127.0.0.1:8080";
  const model = process.env.LLAMA_MODEL?.trim() || "qwen3.5-9b";
  const retriesText = process.env.LLAMA_RETRIES?.trim() || "2";
  const timeoutText = process.env.LLAMA_TIMEOUT_SECONDS?.trim() || "30";
  const retries = Number(retriesText);
  const timeoutSeconds = Number(timeoutText);
  const timeoutMilliseconds = Math.ceil(timeoutSeconds * 1_000);
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new Error(`Invalid LLAMA_RETRIES: ${retriesText}`);
  }
  if (
    !Number.isFinite(timeoutSeconds)
    || timeoutSeconds <= 0
    || !Number.isSafeInteger(timeoutMilliseconds)
    || timeoutMilliseconds > 2_147_483_647
  ) {
    throw new Error(`Invalid LLAMA_TIMEOUT_SECONDS: ${timeoutText}`);
  }
  let url: URL;
  try {
    url = new URL("/v1/chat/completions", serverUrl);
  } catch {
    throw new Error(`Invalid LLAMA_SERVER_URL: ${serverUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid LLAMA_SERVER_URL protocol: ${url.protocol}`);
  }
  return { url, model, retries, timeoutSeconds };
}

async function complete(
  systemPrompt: string,
  messages: readonly string[],
  maxTokens: number,
  format?: (result: string) => string,
): Promise<string> {
  if (
    !Array.isArray(messages)
    || messages.length === 0
    || messages.some((message) => typeof message !== "string" || message.trim() === "")
  ) {
    throw new Error("Llama messages must be a non-empty array of non-blank strings");
  }

  const { url, model, retries, timeoutSeconds } = config();
  const requestMessages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: JSON.stringify(messages) },
  ];
  for (let attempt = 0; ; attempt++) {
    try {
      const signal = AbortSignal.timeout(Math.ceil(timeoutSeconds * 1_000));
      let response: Response;
      let text: string;
      try {
        console.debug(LOGTAG, "completion requested", { content: messages, retries: attempt });
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: requestMessages,
            temperature: 0,
            max_tokens: maxTokens,
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal,
        });
        text = await response.text();
      } catch (cause) {
        if (signal.aborted) {
          throw new RetryableLlamaError(`llama.cpp request timed out after ${timeoutSeconds} seconds`);
        }
        throw new Error(`llama.cpp request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }

      if (!response.ok) {
        throw new Error(`llama.cpp request failed (${response.status}): ${text.trim() || response.statusText}`);
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new RetryableLlamaError("Malformed llama.cpp response: invalid JSON");
      }
      if (typeof body !== "object" || body === null) {
        throw new RetryableLlamaError("Malformed llama.cpp response: missing completion content");
      }
      const choices = (body as ChatCompletion).choices;
      const content = Array.isArray(choices) ? choices[0]?.message?.content : undefined;
      if (typeof content !== "string") {
        throw new RetryableLlamaError("Malformed llama.cpp response: missing completion content");
      }
      console.debug(LOGTAG, "completion received", { response: content, retries: attempt });
      const result = content.trim();
      if (result === "") throw new RetryableLlamaError("llama.cpp returned an empty completion");
      return format?.(result) ?? result;
    } catch (cause) {
      if (!(cause instanceof RetryableLlamaError) || attempt >= retries) throw cause;
    }
  }
}

function classification(result: string): string {
  const label = /^:([^:\r\n]+):$/.exec(result)?.[1] ?? result;
  if (!CLASSIFICATIONS.has(label)) throw new RetryableLlamaError(`Unexpected llama.cpp classification: ${result}`);
  return label;
}

export function llama_classify(messages: readonly string[]): Promise<string> {
  return complete(CLASSIFIER_PROMPT, messages, 16, classification);
}

export function llama_describe(messages: readonly string[]): Promise<string> {
  return complete(NAMEGIVER_PROMPT, messages, 64);
}
