// =============================================================================
// src/repostWorker.ts — outbox dispatcher for channel reposts
//
// Flow (option B, async callback over Tailscale):
//   1. claim()       — lock one pending row (SKIP LOCKED, safe for >1 worker)
//   2. dispatchOne() — POST signed job to n8n, expect 202, mark 'dispatched'
//   3. n8n formats + sends via Bot API, then calls back
//   4. applyResult() — called by the /callback/repost-result route in listener.ts
//
// The service owns Supabase; n8n never touches it. Every message in both
// directions is HMAC-signed, so a compromised n8n can only report one of three
// outcomes for a row it was already given.
//
// Row lifecycle:
//   pending -> sending -> dispatched -> sent
//                              |          ^
//                              +-> pending (retry / failed-but-attempts-left)
//                              +-> failed (attempts exhausted)
// =============================================================================

import { db } from "./db";
import { sign, verify } from "./signing";

const N8N_URL       = process.env.N8N_REPOST_WEBHOOK!;   // http://<n8n>.<tailnet>.ts.net:5678/webhook/...
const MAX_ATTEMPTS  = Number(process.env.REPOST_MAX_ATTEMPTS ?? 5);
const DISPATCH_TIMEOUT_MS = Number(process.env.REPOST_DISPATCH_TIMEOUT_MS ?? 5_000);
const IDLE_POLL_MS  = Number(process.env.REPOST_IDLE_POLL_MS ?? 1_000);
// How long a row may sit in sending/dispatched before it's re-dispatched.
// Must exceed n8n's worst case (rate-limit Wait loops), or you'll double-work
// rows — n8n's static-data dedupe makes that safe, but it wastes executions.
const STUCK_AFTER   = process.env.REPOST_STUCK_AFTER ?? "5 minutes";

// ---- Result envelope n8n sends back -----------------------------------------
export type RepostResult =
  | { outbox_id: number; status: "sent"; tg_message_id: number }
  | { outbox_id: number; status: "retry"; retry_after: number; error?: string }
  | { outbox_id: number; status: "failed"; error: string };

let stopped = false;
let running = false;

/** Called from shutdown(): stop claiming new rows. In-flight dispatch finishes. */
export function stopRepostWorker(): void {
  stopped = true;
}

// =============================================================================
// Claim one row
// =============================================================================
// FOR UPDATE SKIP LOCKED means concurrent workers never grab the same row.
// The stuck-row arm recovers jobs whose callback never arrived (n8n restarted,
// tailnet blip, container redeploy mid-flight).
async function claim(): Promise<any | null> {
  const { rows } = await db.query(
    `update repost_outbox
        set status = 'sending',
            attempts = attempts + 1,
            claimed_at = now()
      where id = (
        select id
          from repost_outbox
         where attempts < $1
           and (
                 (status = 'pending'
                   and (next_attempt_at is null or next_attempt_at <= now()))
              or (status in ('sending', 'dispatched')
                   and claimed_at < now() - $2::interval)
               )
         order by created_at
         limit 1
         for update skip locked
      )
      returning *`,
    [MAX_ATTEMPTS, STUCK_AFTER],
  );
  return rows[0] ?? null;
}

// =============================================================================
// Apply an outcome — also called directly by the callback HTTP route
// =============================================================================
// Idempotent by design: every branch guards on `status <> 'sent'`, so a
// duplicate or late callback after a successful send is a no-op. This is what
// makes n8n's retry-on-fail and the stuck-row re-dispatch safe.
export async function applyResult(r: RepostResult): Promise<void> {
  if (!r || typeof r.outbox_id !== "number") return;

  switch (r.status) {
    case "sent":
      await db.query(
        `update repost_outbox
            set status = 'sent',
                sent_at = now(),
                tg_message_id = $2,
                last_error = null
          where id = $1
            and status <> 'sent'`,
        [r.outbox_id, r.tg_message_id],
      );
      break;

    case "retry":
      // Telegram 429: n8n exhausted its in-flow Wait loop and handed the delay back
      await db.query(
        `update repost_outbox
            set status = 'pending',
                last_error = $2,
                next_attempt_at = now() + make_interval(secs => $3)
          where id = $1
            and status <> 'sent'`,
        [r.outbox_id, (r.error ?? "rate_limited").slice(0, 500), Math.min(Math.max(1, r.retry_after), 3600)],
      );
      break;

    case "failed":
      // Retry until attempts run out, then park the row for manual review
      await db.query(
        `update repost_outbox
            set status = case when attempts >= $3 then 'failed' else 'pending' end,
                last_error = $2,
                next_attempt_at = now() + interval '30 seconds'
          where id = $1
            and status <> 'sent'`,
        [r.outbox_id, String(r.error).slice(0, 500), MAX_ATTEMPTS],
      );
      break;
  }
}

// =============================================================================
// Dispatch one job to n8n
// =============================================================================
async function dispatchOne(row: any): Promise<void> {
  try {
    const res = await fetch(N8N_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sign({ outbox_id: row.id, payload: row.payload })),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });

    // n8n webhook is set to "Respond Immediately" with code 202
    if (res.status !== 202) throw new Error(`n8n responded ${res.status}`);

    // Accepted: wait for the callback. If it never comes, the stuck-row arm of
    // claim() re-dispatches, and n8n's static-data dedupe prevents a double post.
    await db.query(
      `update repost_outbox
          set status = 'dispatched', claimed_at = now()
        where id = $1 and status = 'sending'`,
      [row.id],
    );

    // Optional: n8n may answer synchronously with a signed result instead of 202.
    // Kept here so switching back to option A needs no worker changes.
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = await res.json().catch(() => null);
      const result = body ? (verify(body) as RepostResult | null) : null;
      if (result && result.outbox_id === row.id) await applyResult(result);
    }
  } catch (err) {
    // Couldn't reach n8n, or it rejected the job. Safe to retry: n8n dedupes
    // by outbox_id, so a job it already posted won't post twice.
    console.error(`repost dispatch failed id=${row.id}`, String(err));
    await applyResult({ outbox_id: row.id, status: "failed", error: String(err) });
  }
}

// =============================================================================
// Worker loop
// =============================================================================
// Serial by design: one outstanding send at a time paces Telegram's per-chat
// rate limit and keeps channel post order matching call order.
export async function runRepostWorker(): Promise<void> {
  if (running) return;                 // guard against double-start
  running = true;
  stopped = false;
  console.log("repost worker started");

  while (!stopped) {
    try {
      const row = await claim();
      if (!row) {
        await sleep(IDLE_POLL_MS);
        continue;
      }
      await dispatchOne(row);
    } catch (err) {
      // DB unreachable or similar: back off so we don't spin on errors
      console.error("repost worker loop error", String(err));
      await sleep(5_000);
    }
  }

  running = false;
  console.log("repost worker stopped");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// =============================================================================
// Ops helper: park rows that keep failing, so they stop being re-claimed
// =============================================================================
export async function listFailed(limit = 50) {
  const { rows } = await db.query(
    `select id, signal_id, dedupe_key, attempts, last_error, created_at
       from repost_outbox
      where status = 'failed'
      order by created_at desc
      limit $1`,
    [limit],
  );
  return rows;
}