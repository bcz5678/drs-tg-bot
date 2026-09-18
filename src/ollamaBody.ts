// =============================================================================
// src/ollamaBody.ts — builds the Ollama /api/chat request for the "llm" route
//
// PROMPT CACHE CONTRACT (this is why MODEL/OPTIONS/SYSTEM/SCHEMA are module-level
// constants and not built per call):
//   Ollama reuses the KV cache only when everything BEFORE the user message is
//   byte-identical between consecutive requests on the same loaded model/slot.
//   Requirements, all of which must hold:
//     1. Model stays loaded            -> keep_alive: -1 + OLLAMA_KEEP_ALIVE=-1
//     2. One KV slot                   -> OLLAMA_NUM_PARALLEL=1
//     3. Identical MODEL/OPTIONS/SYSTEM/SCHEMA every request  -> constants below
//     4. No other caller hits this Ollama with a different prompt (it would
//        overwrite the single slot's cached prefix)
//   Never interpolate variables, timestamps, or per-message data into SYSTEM.
//   Editing SYSTEM invalidates the cache until the next warmup call.
// =============================================================================

import type { PrefilterAddress, PrefilterResult } from "./prefilter";

// ---- Model ------------------------------------------------------------------
// Switch to qwen3.5:4b if live testing shows misclassification on the llm route.
// Any change here invalidates the cache and forces a model load on the next call.
const MODEL = "qwen3.5:2b";

// ---- Inference options ------------------------------------------------------
// Must be identical on EVERY request: differing options make Ollama reload the
// runner (the ~3s load_duration seen during tuning) and drop the cached prefix.
const OPTIONS = {
  temperature: 0,      // deterministic extraction
  num_ctx: 1024,       // Telegram posts are short; small KV cache = less RAM, faster prefill
  num_predict: 200,    // compact JSON is ~35 tokens; cap stops runaway generation
  num_thread: 4,       // set to PHYSICAL cores of the host, not vCPU/hyperthreads
} as const;

const CHAINS = ["SOL", "ETH", "BNB", "ARC", "ROBINHOOD"] as const;

// ---- Output schema ----------------------------------------------------------
// Lean by design: regex already owns addresses, chain and ticker, so the model
// returns an INDEX rather than a 44-char base58 string (~30 fewer output tokens
// per message, and it structurally cannot hallucinate an address).
const SCHEMA = {
  type: "object",
  properties: {
    kind:           { type: "string", enum: ["call", "update", "exit", "noise"] },
    address_index:  { type: ["integer", "null"] },
    chain_override: { type: ["string", "null"], enum: [...CHAINS, null] },
    entry_mcap_usd: { type: ["number", "null"] },
    targets:        { type: "array", items: { type: "string" } },
  },
  required: ["kind", "address_index", "chain_override", "entry_mcap_usd", "targets"],
} as const;

// ---- System prompt (STATIC — see cache contract above) ----------------------
const SYSTEM =
  "Classify a Telegram crypto message. " +
  "Output compact single-line JSON with no spaces or newlines. " +
  "kind: call (new token signal), update (progress on a prior call), exit (sold/closed), noise (anything else). " +
  "address_index: index N of the token address shown as <ADDRN> in candidates, or null. " +
  "chain_override: only when that candidate's via is none or keyword and the text clearly names a different chain; otherwise null. " +
  "entry_mcap_usd: number (100.77K -> 100770) or null. " +
  "targets: price or multiple targets as short strings, else [].";

// ---- Per-message text compaction -------------------------------------------
// Emoji, box-drawing chars and URLs cost tokens without adding signal — chains
// were already resolved from URLs during prefiltering.
const DECORATION_RE = /[\p{Extended_Pictographic}\u2500-\u257F\uFE0F\u200D]/gu;
const MAX_TEXT_CHARS = 800;

/**
 * Compacts message text for the prompt:
 *  - replaces each candidate address with <ADDRN>, matching the candidate list
 *    (a base58/hex address tokenizes to 25-35 tokens on its own)
 *  - strips URLs, emoji and box-drawing decoration
 *  - collapses whitespace and caps length
 */
function compactText(text: string, addresses: PrefilterAddress[]): string {
  let out = text ?? "";

  addresses.forEach((a, i) => {
    out = out.split(a.address).join(`<ADDR${i}>`);   // literal replace, no regex escaping
  });

  return out
    .replace(/https?:\/\/\S+/g, "<URL>")
    .replace(DECORATION_RE, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

/** The request body POSTed to {OLLAMA_URL}/api/chat. */
export interface OllamaChatBody {
  model: string;
  stream: false;
  think: false;
  keep_alive: number;
  options: typeof OPTIONS;
  format: typeof SCHEMA;
  messages: Array<{ role: "system" | "user"; content: string }>;
}

/**
 * Builds the chat request for one message.
 * Everything that varies per message lives in the final user turn, AFTER the
 * cached prefix (system + schema), so only ~60-120 tokens need prefilling.
 */
export function buildOllamaBody(pre: PrefilterResult): OllamaChatBody {
  const addresses = pre.addresses ?? [];

  // Compact candidate lines: "0 SOL label" is ~4 tokens vs ~30 for a JSON object.
  // Index position here is what the model returns as address_index.
  const candidates = addresses.length
    ? addresses.map((a, i) => `${i} ${a.chain} ${a.via}`).join("\n")
    : "none";

  const text = compactText(pre.text ?? "", addresses);

  return {
    model: MODEL,
    stream: false,
    think: false,        // Qwen3.5 thinking multiplies latency on CPU
    keep_alive: -1,      // never unload (OLLAMA_KEEP_ALIVE=-1 enforces this server-side too)
    options: OPTIONS,
    format: SCHEMA,      // decode-time constraint, not post-hoc parsing
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `candidates:\n${candidates}\n\n${text}` },
    ],
  };
}

// Exported for the warmup call and for tests asserting the prefix never drifts
export const PROMPT_PREFIX = { MODEL, OPTIONS, SYSTEM, SCHEMA } as const;