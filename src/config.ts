import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  tgApiId: required("TG_API_ID"),
  tgApiHash: required("TG_API_HASH"),
  tgSession: process.env.TG_SESSION ?? "",
  tgChannels: (process.env.TG_CHANNELS ?? "").split(",").filter(Boolean),
  databaseUrl: required("DATABASE_URL"),
  ollamaUrl: process.env.OLLAMA_URL ?? "http://127.0.0.1:11434",
  n8nRepostWebhook: process.env.N8N_REPOST_WEBHOOK ?? "",
  repostHmacSecret: process.env.REPOST_HMAC_SECRET ?? "",
  callbackBind: process.env.CALLBACK_BIND ?? "127.0.0.1",
  callbackPort: Number(process.env.CALLBACK_PORT ?? 8787),
};
