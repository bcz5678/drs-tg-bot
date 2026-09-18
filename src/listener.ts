// =============================================================================
// src/listener.ts — Telegram call pipeline entrypoint
//
// Owns: MTProto connection, startup backfill, message routing, repost worker,
//       callback + health HTTP server, graceful shutdown.
// Imports: prefilter / buildOllamaBody / validate (ported n8n Code nodes),
//          sign / verify (HMAC envelope), applyResult (outbox state machine).
// =============================================================================

import { createServer, type Server } from "node:http";
import { TelegramClient, Api } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { NewMessage, EditedMessage } from "teleproto/events";

import { db } from "./db";
import { prefilter } from "./prefilter";
import { buildOllamaBody } from "./ollamaBody";
import { validate } from "./validate";
import { verify } from "./signing";
import { applyResult, runRepostWorker, stopRepostWorker } from "./repostWorker";

// ---- Config -----------------------------------------------------------------
const CHANNELS = (process.env.TG_CHANNELS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const OLLAMA_URL      = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const OLLAMA_TIMEOUT  = Number(process.env.OLLAMA_TIMEOUT_MS ?? 30_000);
const CALLBACK_BIND   = process.env.CALLBACK_BIND ?? "0.0.0.0";   // container-internal
const CALLBACK_PORT   = Number(process.env.CALLBACK_PORT ?? 8787);
const HEALTH_STALE_MS = Number(process.env.HEALTH_STALE_MIN ?? 30) * 60_000;
const REPOST_MIN_CONF = Number(process.env.REPOST_MIN_CONFIDENCE ?? 0.7);

const client = new TelegramClient(
  new StringSession(process.env.TG_SESSION ?? ""),   // from the one-time login script
  Number(process.env.TG_API_ID),
  process.env.TG_API_HASH!,
  { connectionRetries: Infinity, autoReconnect: true, retryDelay: 2_000 },
);

// ---- Runtime state ----------------------------------------------------------
let lastUpdateAt = Date.now();     // health: "have we heard from Telegram lately?"
let shuttingDown = false;
let inFlight = 0;                  // handlers currently running, for drain-on-exit

// =============================================================================
// Ollama: strictly serial queue
// One request at a time keeps the single KV slot's prompt cache intact
// (OLLAMA_NUM_PARALLEL=1) and paces CPU inference.
// =============================================================================
let ollamaChain: Promise<unknown> = Promise.resolve();

function enqueueOllama<T>(fn: () => Promise<T>): Promise<T> {
  const run = ollamaChain.then(fn);
  ollamaChain = run.then(() => undefined, () => undefined);  // survive rejections
  return run;
}

async function callOllama(body: unknown): Promise<any> {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),                 // real object: no escaping issues
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

// =============================================================================
// Normalize a teleproto message into the Bot-API-ish shape prefilter expects
// =============================================================================
type NormalizedMessage = {
  chat_id: string | undefined;
  message_id: number;
  date: number;
  text: string;
  entities: Array<{ type: "text_link"; url: string; offset: number; length: number }>;
  reply_to_message: { text: string; entities: NormalizedMessage["entities"] } | null;
};

// Hidden text_link URLs are often the only chain evidence in a post
function toEntities(m?: Api.Message): NormalizedMessage["entities"] {
  return (m?.entities ?? [])
    .filter((e): e is Api.MessageEntityTextUrl => e instanceof Api.MessageEntityTextUrl)
    .map((e) => ({ type: "text_link" as const, url: e.url, offset: e.offset, length: e.length }));
}

async function normalize(msg: Api.Message): Promise<NormalizedMessage> {
  // Replies carry the original call's CA for "TP hit"/"sold" posts with no address
  let reply: Api.Message | undefined;
  if (msg.replyTo) {
    reply = (await msg.getReplyMessage().catch(() => undefined)) ?? undefined;
  }

  return {
    chat_id: msg.chatId?.toString(),
    message_id: msg.id,
    date: msg.date,
    text: msg.message ?? "",
    entities: toEntities(msg),
    reply_to_message: reply
      ? { text: reply.message ?? "", entities: toEntities(reply) }
      : null,
  };
}

// =============================================================================
// Per-message pipeline: prefilter -> route -> (Ollama) -> validate -> persist
// =============================================================================
async function handle(msg: Api.Message, edited = false): Promise<void> {
  if (shuttingDown) return;
  inFlight++;
  try {
    const item = await normalize(msg);
    lastUpdateAt = Date.now();

    const pre = prefilter(item);

    // --- drop route: log only, so live testing can review what was missed ---
    if (pre.route === "drop") {
      await db.query(
        `insert into prefilter_log (chat_id, message_id, route, route_reason, raw)
         values ($1,$2,$3,$4,$5)
         on conflict (chat_id, message_id) do nothing`,
        [item.chat_id, item.message_id, pre.route, pre.routeReason, item],
      );
      return;
    }

    // --- llm route: serialized Ollama call; never lose the message on failure ---
    let llmRes: any = null;
    let routeReason = pre.routeReason;

    if (pre.route === "llm") {
      try {
        llmRes = await enqueueOllama(() => callOllama(buildOllamaBody(pre)));
      } catch (err) {
        // Ollama down/slow: persist with a marker and reprocess later rather than drop
        routeReason = "llm_unavailable";
        console.error("ollama failed", item.chat_id, item.message_id, String(err));
      }
    }

    const out = validate(pre, llmRes);

    const { rows } = await db.query(
      `insert into signals (chat_id, message_id, edited, kind, chain, chain_via,
                            contract_address, ticker, entry_mcap_usd, targets,
                            confidence, route, route_reason, perf, raw_text)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       on conflict (chat_id, message_id) do update
         set edited = true,
             kind = excluded.kind,
             chain = excluded.chain,
             contract_address = excluded.contract_address,
             ticker = excluded.ticker,
             entry_mcap_usd = excluded.entry_mcap_usd,
             confidence = excluded.confidence,
             route_reason = excluded.route_reason,
             raw_text = excluded.raw_text
       returning id`,
      [item.chat_id, item.message_id, edited, out.kind, out.chain, out.chain_via,
       out.contract_address, out.ticker, out.entry_mcap_usd, JSON.stringify(out.targets ?? []),
       out.confidence, pre.route, routeReason, out.perf ?? null, out.raw_text],
    );
    const signalId = rows[0]?.id;

    // --- queue confident new calls for repost (worker + n8n do the sending) ---
    // Edits are excluded: a call already reposted shouldn't post twice on edit.
    if (!edited && signalId && out.ok && out.kind === "call" &&
        out.confidence >= REPOST_MIN_CONF && out.contract_address) {
      const dedupeKey = `${out.chain}:${out.contract_address.toLowerCase()}`;
      await db.query(
        `insert into repost_outbox (signal_id, dedupe_key, payload)
         values ($1,$2,$3)
         on conflict (dedupe_key) do nothing`,
        [signalId, dedupeKey, out],
      );
      // No webhook ping here: the worker claims pending rows on its own loop.
    }
  } catch (err) {
    console.error("handle failed", String(err));
  } finally {
    inFlight--;
  }
}

// =============================================================================
// Startup backfill: replay messages posted while the process was down
// =============================================================================
async function backfill(): Promise<void> {
  for (const channel of CHANNELS) {
    try {
      const { rows } = await db.query(
        `select max(message_id)::bigint as max_id from signals where chat_ref = $1`,
        [channel],
      );
      const minId = Number(rows[0]?.max_id ?? 0);
      if (!minId) { console.log(`backfill ${channel}: no watermark, skipping`); continue; }

      // Newest-first; cap so a long outage can't flood the queue on boot
      const msgs = await client.getMessages(channel, { minId, limit: 200 });
      console.log(`backfill ${channel}: ${msgs.length} message(s) since ${minId}`);

      // Oldest-first so reply lookups and dedupe behave like live order
      for (const m of [...msgs].reverse()) {
        if (shuttingDown) return;
        await handle(m as Api.Message);
      }
    } catch (err) {
      console.error(`backfill ${channel} failed`, String(err));
    }
  }
}

// =============================================================================
// HTTP: health + n8n repost-result callback (reached over Tailscale)
// =============================================================================
function startHttpServer(): Server {
  const server = createServer(async (req, res) => {
    // ---- health: Coolify polls this; report the Telegram link, not just liveness
    if (req.method === "GET" && req.url === "/health") {
      const stale = Date.now() - lastUpdateAt > HEALTH_STALE_MS;
      const ok = !shuttingDown && client.connected === true && !stale;
      res.writeHead(ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok, connected: client.connected === true, stale,
        lastUpdateAt: new Date(lastUpdateAt).toISOString(), inFlight,
      }));
      return;
    }

    // ---- n8n -> service: outcome of a repost send
    if (req.method === "POST" && req.url === "/callback/repost-result") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 64_000) { res.writeHead(413).end(); return; }  // size cap
      }
      try {
        const result = verify(JSON.parse(raw));   // HMAC + 5-min replay window
        if (!result) { res.writeHead(401).end(); return; }
        await applyResult(result as any);         // idempotent; duplicate callbacks are no-ops
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(CALLBACK_PORT, CALLBACK_BIND, () =>
    console.log(`http listening on ${CALLBACK_BIND}:${CALLBACK_PORT}`));
  return server;
}

// =============================================================================
// Graceful shutdown — SIGTERM arrives on every Coolify redeploy
// =============================================================================
let httpServer: Server | undefined;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining`);

  const done = (async () => {
    stopRepostWorker();                                  // stop claiming new outbox rows
    httpServer?.close();                                 // refuse new callbacks
    await client.disconnect().catch(() => {});           // stop Telegram updates

    // Let in-flight handlers finish their DB writes (bounded)
    const deadline = Date.now() + 8_000;
    while (inFlight > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (inFlight > 0) console.warn(`exiting with ${inFlight} handler(s) unfinished`);

    await ollamaChain.catch(() => {});                   // let a running inference settle
    await db.end().catch(() => {});                      // close pool cleanly
  })();

  // Hard cap: Docker SIGKILLs at ~10s by default, so never exceed it
  await Promise.race([done, new Promise((r) => setTimeout(r, 9_000))]);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT",  () => void shutdown("SIGINT"));

// Never die silently on a rejected promise inside a handler
process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException",  (e) => { console.error("uncaughtException", e); void shutdown("uncaughtException"); });

// =============================================================================
// Main
// =============================================================================
async function main(): Promise<void> {
  if (!CHANNELS.length) throw new Error("TG_CHANNELS is empty");
  if (!process.env.TG_SESSION) throw new Error("TG_SESSION missing — run login-once.ts");

  httpServer = startHttpServer();

  await client.connect();
  console.log("telegram connected");

  // Handlers must never throw, or the update loop can stall
  client.addEventHandler(
    (e: any) => void handle(e.message).catch(console.error),
    new NewMessage({ chats: CHANNELS }),
  );
  // Callers often edit the CA into a post seconds after publishing
  client.addEventHandler(
    (e: any) => void handle(e.message, true).catch(console.error),
    new EditedMessage({ chats: CHANNELS }),
  );

  await backfill();

  // Warm the model + prompt cache so the first real llm-route message isn't slow
  await enqueueOllama(() =>
    callOllama(buildOllamaBody(prefilter({ text: "warmup $TEST", entities: [] } as any)))
  ).catch((e) => console.warn("warmup skipped:", String(e)));

  void runRepostWorker();   // background loop; checks its own stop flag

  console.log(`listening on ${CHANNELS.length} channel(s)`);
}

main().catch((err) => { console.error("fatal", err); process.exit(1); });