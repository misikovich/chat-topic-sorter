import process from "node:process";

import type { TwitchConfig } from "./twitch.ts";
import { TwitchChatbot } from "./twitch.ts";

const LOGTAG = "[MAIN]";

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new Error(`Missing environment variable: ${name}`);
  return value;
}

export function twitchConfig(env: Record<string, string | undefined>): TwitchConfig {
  const broadcasterId = required(env, "TWITCH_BROADCASTER_ID");
  return {
    clientId: required(env, "TWITCH_CLIENT_ID"),
    accessToken: required(env, "TWITCH_ACCESS_TOKEN"),
    broadcasterId,
    botUserId: env.TWITCH_BOT_USER_ID?.trim() || broadcasterId,
  };
}

async function main(): Promise<void> {
  const config = twitchConfig(process.env);
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
    for await (const message of bot.messages()) {
      console.info(LOGTAG, `[${message.senderName}] ${message.text}`);
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
