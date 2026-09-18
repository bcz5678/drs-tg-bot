// =============================================================================
// src/validate.ts — merges deterministic prefilter output with the LLM result
//
// Authority order, strongest first:
//   1. Regex/template evidence (addresses, chain via url/label, parsed mcap)
//   2. LLM output (kind, chain only when evidence is weak, mcap fallback, targets)
// The model returns an INDEX into pre.addresses, never an address string, so a
// hallucinated CA is structurally impossible. Index order here must match the
// order buildOllamaBody used — both read pre.addresses without re-sorting.
//
// Handles both routes:
//   structured -> called with llmRes = null
//   llm        -> called with the parsed Ollama /api/chat response
// =============================================================================

import type { PrefilterResult, PrefilterAddress, ChainVia } from "./prefilter";

// ---- LLM output shape (constrained by SCHEMA in ollamaBody.ts) --------------
interface LlmOutput {
  kind: "call" | "update" | "exit" | "noise";
  address_index: number | null;
  chain_override: string | null;
  entry_mcap_usd: number | null;
  targets: string[];
}

export interface Perf {
  path: "structured" | "llm" | "llm_failed";
  total_s: number;
  load_s?: number;
  prompt_tokens?: number;
  prefill_s?: number;
  output_tokens?: number;
  gen_s?: number;
  done_reason?: string;
  reloaded?: boolean;     // true = keep_alive / differing options problem
  cache_miss?: boolean;   // true = prompt prefix changed or slot was overwritten
}

export interface ValidateResult {
  ok: boolean;
  kind: LlmOutput["kind"];
  chain: string | null;
  chain_via: ChainVia | "llm" | null;
  contract_address: string | null;
  maybe_pair: boolean;
  ticker: string | null;
  all_tickers: string[];
  entry_mcap_usd: number | null;
  targets: string[];
  confidence: number;
  // Template-derived aggregator fields (null on non-template messages)
  template: string | null;
  caller: string | null;
  caller_tier: string | null;
  caller_cpw: number | null;
  multiplier: number | null;
  error: string | null;
  raw_text: string;
  perf: Perf;
}

const CHAINS = ["SOL", "ETH", "BNB", "ARC", "ROBINHOOD"] as const;

// Deterministic evidence the model is never allowed to override.
// Superset of prefilter's STRUCTURED_VIA: "suffix"/"format" are trusted for
// CHAIN, but not strong enough on their own to skip the LLM entirely.
const TRUSTED_VIA: ChainVia[] = ["url+address", "url", "label", "suffix", "format"];

// Confidence from evidence strength rather than model self-reporting —
// a small model's own confidence score is not informative.
const VIA_CONFIDENCE: Record<string, number> = {
  "url+address": 0.95,
  url: 0.85,
  label: 0.85,
  suffix: 0.70,
  format: 0.70,
  llm: 0.55,
  keyword: 0.50,
  none: 0.30,
};

const sec = (ns?: number) => (ns ? +(ns / 1e9).toFixed(2) : 0);

/** Perf metrics from the Ollama response (durations are nanoseconds). */
function buildPerf(res: any): Perf {
  if (!res) return { path: "structured", total_s: 0 };
  return {
    path: "llm",
    total_s: sec(res.total_duration),
    load_s: sec(res.load_duration),
    prompt_tokens: res.prompt_eval_count ?? 0,
    prefill_s: sec(res.prompt_eval_duration),
    output_tokens: res.eval_count ?? 0,
    gen_s: sec(res.eval_duration),
    done_reason: res.done_reason,
    reloaded: sec(res.load_duration) > 0.5,       // model was unloaded between calls
    cache_miss: sec(res.prompt_eval_duration) > 1.0, // rough flag; tune per host
  };
}

export function validate(pre: PrefilterResult, llmRes: any | null): ValidateResult {
  const perf = buildPerf(llmRes);
  const candidates: PrefilterAddress[] = pre.addresses ?? [];
  const tickers = pre.tickers ?? [];

  // ---- Parse LLM output -----------------------------------------------------
  let llm: LlmOutput | null = null;
  let parseError: string | null = null;

  if (llmRes) {
    try {
      llm = JSON.parse(llmRes.message?.content ?? "");
    } catch {
      // done_reason "length" means num_predict truncated the JSON
      parseError = `unparseable_llm_output:${llmRes.done_reason ?? "unknown"}`;
      perf.path = "llm_failed";
    }
  }

  // ---- kind: LLM > template > structured default ----------------------------
  // Structured-path messages are new calls by construction: prefilter only takes
  // the fast path when no update/exit language is present.
  const kind: LlmOutput["kind"] = llm?.kind ?? pre.fastKind ?? "call";

  // ---- Address: resolve by index; the model never emits the string ----------
  let idx: number | null = null;
  if (llm && Number.isInteger(llm.address_index)) {
    const i = llm.address_index as number;
    if (i >= 0 && i < candidates.length) idx = i;
  }
  // Fallback: a single unambiguous candidate on a non-noise message
  if (idx === null && candidates.length === 1 && kind !== "noise") idx = 0;

  const cand = idx === null ? null : candidates[idx];

  // ---- Chain: deterministic evidence wins; override only weak evidence ------
  let chain: string | null = cand?.chain ?? null;
  let chainVia: ValidateResult["chain_via"] = cand?.via ?? null;

  if (cand && !TRUSTED_VIA.includes(cand.via) &&
      llm?.chain_override && (CHAINS as readonly string[]).includes(llm.chain_override)) {
    // Family guard: a 0x address can never be SOL, base58 can never be EVM
    const overrideFamily = llm.chain_override === "SOL" ? "solana" : "evm";
    if (overrideFamily === cand.family) {
      chain = llm.chain_override;
      chainVia = "llm";
    }
  }

  // ---- Market cap: regex parse beats model arithmetic -----------------------
  const llmMcap =
    typeof llm?.entry_mcap_usd === "number" &&
    Number.isFinite(llm.entry_mcap_usd) &&
    llm.entry_mcap_usd > 0
      ? llm.entry_mcap_usd
      : null;
  const mcap = pre.mcap ?? llmMcap;

  // ---- Ticker: template capture > single regex hit > none -------------------
  // toUpperCase() leaves CJK unchanged, so $龙虾 survives intact.
  const ticker = pre.template?.ticker
    ? pre.template.ticker.replace(/^\$/, "")
    : tickers.length === 1
      ? tickers[0].replace(/^\$/, "").toUpperCase()
      : null;

  // ---- Confidence -----------------------------------------------------------
  let confidence = VIA_CONFIDENCE[chainVia ?? "none"] ?? 0.2;
  if (!cand) confidence = Math.min(confidence, 0.2);                       // no address resolved
  if (llmRes?.done_reason === "length") confidence = Math.min(confidence, 0.3); // truncated
  if (parseError) confidence = Math.min(confidence, 0.2);
  if (cand?.maybePair) confidence = Math.min(confidence, 0.6);             // may be a pair, not the token
  if (pre.isReplyToSignal && cand) confidence = Math.min(confidence, 0.8); // CA inherited from parent

  // ---- ok: is this row actionable downstream? -------------------------------
  // Ticker-only updates stay usable — they match to a prior call by ticker.
  const ok =
    !parseError &&
    kind !== "noise" &&
    (!!cand || ((kind === "update" || kind === "exit") && !!ticker));

  return {
    ok,
    kind,
    chain,
    chain_via: chainVia,
    contract_address: cand?.address ?? null,
    maybe_pair: !!cand?.maybePair,
    ticker,
    all_tickers: tickers,
    entry_mcap_usd: mcap,
    targets: Array.isArray(llm?.targets) ? llm!.targets.slice(0, 10) : [],
    confidence,
    template: pre.template?.name ?? null,
    caller: pre.template?.caller ?? null,
    caller_tier: pre.template?.caller_tier ?? null,
    caller_cpw: pre.template?.caller_cpw ?? null,
    multiplier: pre.template?.multiplier ?? null,
    error: parseError,
    raw_text: pre.text,
    perf,
  };
}