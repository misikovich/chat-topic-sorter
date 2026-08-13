import { readFileSync } from "node:fs";
import process from "node:process";
import { config_init } from "@misikovich/lib-config";
import { string, z } from "zod";

const LOGTAG = "[LLAMA]";
const CFG = config_init("./llama/llama.json", z.object({
  SERVER_URL:             z.url().default("http://127.0.0.1:8080"),
  LLM:                    z.string().default("qwen3.5-9b"),
  MAX_RETRIES:            z.number().default(2),
  MAX_RESPONSE_TIME:      z.number().default(10),
  CLASSIFY_TOKEN_BUDGET:  z.number().default(20),
  CLASSIFY_MODEL_TEMP:    z.number().default(0)
  GIVEANAME_TOKEN_BUDGET: z.number().default(64),
  PROMPT_CLASSIFY:        z.string(),
  PROMPT_GIVEANAME:       z.string()
}))

const CLASSES = new Set(
  [...CFG.PROMPT_CLASSIFY.matchAll(/^- :([^:\r\n]+):\s*$/gm)].map((match) => match[1]!),
);

type ChatCompletion = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

class RetryableLlamaError extends Error {}

async function infer(prompt: string, messages: readonly string[], token_budget: number): Promise<string> {
  const request_seq = [
    { role: "system", content: prompt },
    { role: "user", content: JSON.stringify(messages) },
  ]

  const signal = AbortSignal.timeout(CFG.MAX_RESPONSE_TIME * 1_000)
  let response: Response
  let text: string

  try {
    console.debug(LOGTAG, "model inference..");
    response = await fetch(CFG.SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CFG.LLM,
        messages: request_seq,
        temperature: 0,
        max_tokens: token_budget,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal
    })
    text = await response.text()
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

function class_parse(raw: string): string {
  const clear = raw.replace(':', '')

  if (!CLASSES.has(clear))
    throw new RetryableLlamaError(`Bad llama.cpp response, unexpected class: ${raw}`)

  return clear
}

export function llama_classify(messages: readonly string[]): Promise<string> {
  const raw_response = infer(CFG.PROMPT_CLASSIFY, messages, CFG.CLASSIFY_TOKEN_BUDGET)
  const parsed = class_parse(raw_response);
}

export function llama_describe(messages: readonly string[]): Promise<string> {
  return infer(CFG.PROMPT_GIVEANAME, messages, 64)
}
