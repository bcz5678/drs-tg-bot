// src/signing.ts
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.REPOST_HMAC_SECRET!;   // same value in n8n env
const MAX_SKEW_S = 300;

// Envelope: { ts, data: "<json string>", sig }
export function sign(payload: unknown) {
  const ts = Math.floor(Date.now() / 1000);
  const data = JSON.stringify(payload);
  const sig = createHmac("sha256", SECRET).update(`${ts}.${data}`).digest("hex");
  return { ts, data, sig };
}

export function verify(input: unknown) {
  const env = input as { ts?: unknown; data?: unknown; sig?: unknown } | null;
  if (typeof env?.data !== "string" || typeof env?.sig !== "string" || !Number.isInteger(env.ts)) return null;
  const ts = env.ts as number;
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_S) return null;   // replay window
  const expected = createHmac("sha256", SECRET).update(`${ts}.${env.data}`).digest();
  const given = Buffer.from(env.sig, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return JSON.parse(env.data);
}