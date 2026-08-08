import process from "node:process";

import type { ChatMessage } from "./chatbot.ts";
import { llama_classify, llama_describe } from "./llama.ts";
import { vec_affinity, vec_normalize, vec_sum } from "./vect.ts";

const LOGTAG = "[TOPIC]";
const CONFIRM_COUNT = 5;
const CANDIDATE_TTL = 50;

export type ProcessedMessage = ChatMessage & { vec: number[] }

type Topic = {
    status: "candidate" | "naming" | "confirmed";
    ttl_counter: number;
    vec_centroid: number[];
    vec_sum: number[];
    messages: ProcessedMessage[];
    title: string | null;
}

let Topics: Topic[] = [];

function affinityThreshold(): number {
  const text = process.env.TOPIC_AFFINITY_THRESHOLD?.trim() || "0.5";
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`Invalid TOPIC_AFFINITY_THRESHOLD: ${text}`);
  }
  return value;
}

export function topics(): readonly Topic[] {
  return Topics;
}

export function topics_reset(): void {
  Topics = [];
}

export function topic_infer(message: ProcessedMessage): void {
  let lead_topic: Topic | undefined;
  let lead_affinity = -Infinity;
  for (const topic of Topics) {
    const affinity = vec_affinity(message.vec, topic.vec_centroid);
    if (affinity > lead_affinity) {
      lead_topic = topic;
      lead_affinity = affinity;
    }
  }

  let target: Topic;
  if (lead_topic !== undefined && lead_affinity >= affinityThreshold()) {
    lead_topic.messages.push(message);
    lead_topic.vec_sum = vec_sum(lead_topic.vec_sum, message.vec);
    lead_topic.vec_centroid = vec_normalize(lead_topic.vec_sum);
    lead_topic.ttl_counter = 0;
    target = lead_topic;
    console.debug(LOGTAG, "message joined topic", {
      affinity: lead_affinity,
      messages: lead_topic.messages.length,
      title: lead_topic.title,
    });
  } else {
    target = {
      status: "candidate",
      ttl_counter: 0,
      vec_centroid: message.vec,
      vec_sum: [...message.vec],
      messages: [message],
      title: null,
    };
    Topics.push(target);
    console.debug(LOGTAG, "candidate topic created", { affinity: lead_affinity, topics: Topics.length });
  }

  // TODO: retire confirmed topics after an inactivity window (README step 7).
  Topics = Topics.filter((topic) => {
    if (topic === target || topic.status !== "candidate") return true;
    topic.ttl_counter += 1;
    if (topic.ttl_counter < CANDIDATE_TTL) return true;
    console.debug(LOGTAG, "candidate topic expired", { messages: topic.messages.length });
    return false;
  });

  if (target.status === "candidate" && target.messages.length >= CONFIRM_COUNT) {
    target.status = "naming";
    void confirm(target);
  }
}

async function confirm(topic: Topic): Promise<void> {
  const texts = topic.messages.map((message) => message.text);
  try {
    const label = await llama_classify(texts);
    if (label !== "other") {
      Topics = Topics.filter((existing) => existing !== topic);
      console.info(LOGTAG, "discarded unimportant topic", { label, messages: texts.length });
      return;
    }
    topic.title = await llama_describe(texts);
    topic.status = "confirmed";
    console.info(LOGTAG, "topic confirmed", { title: topic.title, messages: texts.length });
  } catch (cause) {
    topic.status = "candidate";
    console.error(LOGTAG, "topic naming failed", cause instanceof Error ? cause.message : cause);
  }
}
