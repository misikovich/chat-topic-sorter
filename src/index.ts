import process from "node:process";

import type { TwitchConfig } from "./twitch.ts";
import { TwitchChatbot, twitchUserId } from "./twitch.ts";
import { vectorize } from "./embedding.ts";
import { topic_infer, type ProcessedMessage } from "./topic.ts";

const LOGTAG = "[MAIN]";

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export async function twitchConfig(env: Record<string, string | undefined>): Promise<TwitchConfig> {
  const clientId = required(env, "TWITCH_CLIENT_ID");
  const accessToken = required(env, "TWITCH_ACCESS_TOKEN");
  const channel = env.TWITCH_CHANNEL?.trim();
  const broadcasterId = channel === undefined || channel === ""
    ? required(env, "TWITCH_BROADCASTER_ID")
    : await twitchUserId(channel, { clientId, accessToken });
  return {
    clientId,
    accessToken,
    broadcasterId,
    botUserId: env.TWITCH_BOT_USER_ID?.trim() || broadcasterId,
  };
}



async function main(): Promise<void> {
  const config = await twitchConfig(process.env);
  console.info(LOGTAG, "starting", {
    broadcasterId: config.broadcasterId,
    botUserId: config.botUserId,
  });
  const bot = new TwitchChatbot(config);
  const close = (): void => {
    console.info(LOGTAG, "shutdown requested");
    bot.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  try {
    for await (const raw of bot.messages()) {
      const vec = await vectorize(raw.text);
      const processed: ProcessedMessage = { ...raw, vec };
      console.debug(LOGTAG, "[MSG]", `[${raw.senderName}]`, `TEXT: [${raw.text.slice(0, 50)}]`, `VEC: [${vec.slice(0, 5)}...]`);
      topic_infer(processed);
    }
  } finally {
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    bot.close();
    console.info(LOGTAG, "stopped");
  }
}

if (import.meta.main) {
  void main().catch((cause: unknown) => {
    console.error(LOGTAG, "fatal error", cause instanceof Error ? cause.message : cause);
    process.exitCode = 1;
  });
}
