import process from "node:process";

import type { ChatMessage } from "./chatbot.ts";
import { llama_describe } from "./llama.ts";
import { vec_affinity, vec_lerp, vec_normalize } from "./vect.ts";

const LOGTAG = "[TOPIC]";
const CONFIRM_COUNT = 5;
const CANDIDATE_TTL = 50;
const COHERENCE_INTERVAL = 4;

export type ProcessedMessage = ChatMessage & { vec: number[] }

export type Topic = {
    status: "candidate" | "naming" | "confirmed";
    ttl_counter: number;
    vec_centroid: number[];
    messages: ProcessedMessage[];
    title: string | null;
    label: string | null;
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

function coherenceThreshold(): number {
  const text = process.env.TOPIC_COHERENCE_THRESHOLD?.trim() || "0.5";
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`Invalid TOPIC_COHERENCE_THRESHOLD: ${text}`);
  }
  return value;
}

function centroidAlpha(): number {
  const text = process.env.TOPIC_CENTROID_ALPHA?.trim() || "0.1";
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`Invalid TOPIC_CENTROID_ALPHA: ${text}`);
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
    lead_topic.vec_centroid = vec_normalize(
      vec_lerp(lead_topic.vec_centroid, vec_normalize(message.vec), centroidAlpha()),
    );
    lead_topic.ttl_counter = 0;
    target = lead_topic;
    console.debug(LOGTAG, "message joined topic", {
      affinity: lead_affinity,
      messages: lead_topic.messages.length,
      title: lead_topic.title,
    });
    if (lead_topic.messages.length % COHERENCE_INTERVAL === 0 && lead_topic.status !== "naming") {
      coherence_check(lead_topic);
    }
  } else {
    target = {
      status: "candidate",
      ttl_counter: 0,
      vec_centroid: vec_normalize(message.vec),
      messages: [message],
      title: null,
      label: null,
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

function coherence_check(topic: Topic): void {
  const affinities = topic.messages.map((message) => vec_affinity(message.vec, topic.vec_centroid));
  const average = affinities.reduce((sum, value) => sum + value, 0) / affinities.length;
  if (average >= coherenceThreshold()) return;

  topic.messages = topic.messages.slice(-CONFIRM_COUNT);
  const mean = topic.messages
    .map((message) => vec_normalize(message.vec))
    .reduce((acc, vec) => acc.map((value, index) => value + vec[index]!));
  topic.vec_centroid = vec_normalize(mean);
  console.info(LOGTAG, "topic regenerated", {
    average,
    messages: topic.messages.length,
    title: topic.title,
  });
  if (topic.status === "confirmed") {
    topic.title = null;
    topic.status = "naming";
    void confirm(topic);
  }
}

async function confirm(topic: Topic): Promise<void> {
  const texts = topic.messages.map((message) => message.text);
  try {
    // Classifier bypassed for now: every topic goes straight to the namegiver.
    topic.title = await llama_describe(texts);
    topic.status = "confirmed";
    console.info(LOGTAG, "topic confirmed", { title: topic.title, messages: texts.length });
  } catch (cause) {
    topic.status = "candidate";
    console.error(LOGTAG, "topic naming failed", cause instanceof Error ? cause.message : cause);
  }
}
