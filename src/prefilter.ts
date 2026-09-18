// =============================================================================
// src/prefilter.ts — deterministic extraction + routing
//
// Runs on every Telegram message before any LLM call. Its job is to pull out
// everything regex can settle (addresses, chain, ticker, mcap, known templates)
// and decide whether the message needs the model at all.
//
// Routes:
//   "drop"       — no token reference; logged to prefilter_log for review
//   "structured" — regex produced a complete, unambiguous record; skips Ollama
//   "llm"        — has a signal but needs classification or fuzzy extraction
// =============================================================================

// ---- Input shape (produced by normalize() in listener.ts) -------------------
export interface NormalizedEntity {
  type: "text_link";
  url: string;
  offset: number;
  length: number;
}

export interface NormalizedInput {
  chat_id?: string;
  message_id?: number;
  date?: number;
  text: string;
  entities?: NormalizedEntity[];
  reply_to_message?: { text: string; entities?: NormalizedEntity[] } | null;
}

// ---- Output shape -----------------------------------------------------------
export interface PrefilterAddress {
  address: string;
  family: "evm" | "solana";
  chain: string;          // SOL | ETH | BNB | ARC | ROBINHOOD | EVM_UNKNOWN
  via: ChainVia;
  maybePair?: boolean;    // dexscreener link: may be the PAIR, not the token
}

export type ChainVia =
  | "url+address" | "url" | "label" | "suffix" | "format" | "keyword" | "none";

export interface TemplateMatch {
  name: string;
  kind: "call" | "update" | "exit" | "noise";
  ticker?: string;
  caller?: string;
  caller_tier?: string;
  caller_cpw?: number;
  multiplier?: number;
  source?: string;
}

export interface PrefilterResult {
  text: string;
  hiddenUrls: string[];
  addresses: PrefilterAddress[];
  tickers: string[];
  mcap: number | null;
  exitOrUpdate: boolean;
  isReplyToSignal: boolean;
  template: TemplateMatch | null;
  fastKind: TemplateMatch["kind"] | null;
  structured: boolean;
  route: "drop" | "structured" | "llm";
  routeReason: string;
}

// =============================================================================
// Chain registry — add or adjust chains here only
//   urlHints: substrings in DEX/explorer URLs (strongest)
//   keywords: loose text mentions; also used to read "Chain: X" labels
//   suffixes: launchpad vanity suffixes (heuristic)
// NOTE: verify ARC / ROBINHOOD explorer + dexscreener slugs against live sites.
// =============================================================================
interface ChainDef {
  family: "evm" | "solana";
  urlHints: string[];
  keywords: RegExp[];
  suffixes: RegExp[];
}

const CHAINS: Record<string, ChainDef> = {
  SOL: {
    family: "solana",
    urlHints: ["dexscreener.com/solana", "solscan.io", "pump.fun", "birdeye.so",
               "gmgn.ai/sol", "photon-sol", "raydium.io", "jup.ag", "bonk.fun", "axiom.trade"],
    keywords: [/\bsol(ana)?\b/i],
    suffixes: [/pump$/, /bonk$/],
  },
  ETH: {
    family: "evm",
    urlHints: ["dexscreener.com/ethereum", "etherscan.io", "gmgn.ai/eth",
               "app.uniswap.org", "dextools.io/app/en/ether"],
    keywords: [/\b(eth|ethereum|erc-?20|mainnet)\b/i],
    suffixes: [],
  },
  BNB: {
    family: "evm",
    urlHints: ["dexscreener.com/bsc", "bscscan.com", "gmgn.ai/bsc",
               "four.meme", "pancakeswap.finance", "dextools.io/app/en/bnb"],
    keywords: [/\b(bnb|bsc|bep-?20|binance smart chain)\b/i],
    suffixes: [/4444$/i],
  },
  ARC: {
    family: "evm",
    urlHints: ["dexscreener.com/arc", "arcscan"],
    keywords: [/\barc( chain| network)?\b/i],
    suffixes: [],
  },
  ROBINHOOD: {
    family: "evm",
    urlHints: ["dexscreener.com/robinhood", "robinhood"],
    keywords: [/\b(robinhood|hood chain|rh chain)\b/i],
    suffixes: [],
  },
};

// Evidence strong enough to skip the LLM. Must stay a subset of validate.ts's
// TRUSTED_VIA — "suffix"/"format" are trusted for chain but too weak for the
// fast path, since a bare address + mcap could be an update rather than a call.
const STRUCTURED_VIA: ChainVia[] = ["url+address", "url", "label"];

// =============================================================================
// Patterns
// =============================================================================
// Exactly 40 hex; trailing lookahead rejects 64-hex tx hashes
const EVM_RE = /\b0x[a-fA-F0-9]{40}(?![0-9a-fA-F])/g;
// base58 32-44, not embedded in a longer run (tx signatures are 87-88 chars)
const SOL_RE = /(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
// Unicode cashtag: $PEPE and $龙虾 both match, $100 does not.
// \b is unreliable across scripts, hence the explicit lookahead.
const TICKER_RE = /\$\p{L}[\p{L}\p{N}]{0,11}(?![\p{L}\p{N}])/gu;
// "MCap: $100.77K", "MC 300k", "Market Cap - $1.2M"
const MCAP_RE = /\b(?:mcap|mc|market\s*cap)\s*[:\-–]?\s*\$?\s*([\d.,]+)\s*([kmb])?\b/i;
// Bot labels: "Chain: 🟣 Solana", "Network: BSC"
const LABEL_RE = /\b(?:chain|network)\s*[:\-–]\s*(?:[\p{Extended_Pictographic}\uFE0F\u200D]\s*)*([A-Za-z][A-Za-z0-9 ]{1,20})/iu;
// Update/exit language. These posts often contain an mcap and must NOT take the
// fast path, which defaults to kind "call".
const EXIT_UPDATE_RE = /\b(tp\s*\d*\s*hit|hit\s*tp|take\s*profit|sold|exit(ed)?|closed?|stop\s*loss|sl\s*hit|rugged?|update|\d+(\.\d+)?\s*x\b|ath|pumped|up\s*\d+\s*%)/i;

const DECO_RE = /[\p{Extended_Pictographic}\uFE0F\u200D]/gu;
const stripDeco = (s: string) => s.replace(DECO_RE, "").trim();

// =============================================================================
// Base58 validation — a real Solana pubkey decodes to exactly 32 bytes.
// Filters long base58-looking words that would otherwise pass the regex.
// =============================================================================
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58ByteLength(s: string): number {
  const bytes: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return -1;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  let zeros = 0;                       // a leading '1' encodes a leading zero byte
  while (s[zeros] === "1") zeros++;
  return bytes.length + zeros;
}

// Cheap mixed-charset check first, so we only decode plausible candidates
const isSolPubkey = (s: string) =>
  /\d/.test(s) && /[a-zA-Z]/.test(s) && base58ByteLength(s) === 32;

// =============================================================================
// Known bot/aggregator templates — fixed formats get kind + fields from regex.
// Add one entry per template observed in your channels.
// =============================================================================
interface TemplateDef {
  name: string;
  re: RegExp;
  build: (m: RegExpMatchArray) => Omit<TemplateMatch, "name">;
  extras?: Array<{ re: RegExp; map: (m: RegExpMatchArray) => Partial<TemplateMatch> }>;
}

const TEMPLATES: TemplateDef[] = [
  {
    // "CryptoWolves Call🦊 just made a 121X Call on $龙虾"
    name: "callanalyser_multiplier",
    re: /^(.+?)\s+just made an?\s+([\d.,]+)\s*x\s+call on\s+(\$\p{L}[\p{L}\p{N}]*)/imu,
    build: (m) => ({
      kind: "update",
      caller: stripDeco(m[1]),
      multiplier: parseFloat(m[2].replace(/,/g, "")),
      ticker: m[3],
    }),
    extras: [
      { re: /\bis\s+(T\d+)\s+on\s+@(\w+)/i, map: (m) => ({ caller_tier: m[1], source: m[2] }) },
      { re: /\bwith\s+([\d,]+)\s+CPW\b/i,   map: (m) => ({ caller_cpw: parseInt(m[1].replace(/,/g, ""), 10) }) },
    ],
  },
];

// =============================================================================
// Main
// =============================================================================
export function prefilter(input: NormalizedInput): PrefilterResult {
  const text = input.text ?? "";
  const hiddenUrls = (input.entities ?? [])
    .filter((e) => e.type === "text_link" && e.url)
    .map((e) => e.url);

  // Replies inherit the original call's address/chain: "TP1 hit" posts usually
  // carry no CA of their own.
  const reply = input.reply_to_message ?? null;
  const repliedText = reply?.text ?? "";
  const repliedUrls = (reply?.entities ?? [])
    .filter((e) => e.type === "text_link" && e.url)
    .map((e) => e.url);

  // Search across message + hidden links + replied message
  const haystack = [text, ...hiddenUrls, repliedText, ...repliedUrls].join("\n");
  const lower = haystack.toLowerCase();
  const urls = haystack.match(/https?:\/\/\S+/g) ?? [];
  const labelName = haystack.match(LABEL_RE)?.[1]?.trim() ?? null;

  // ---- Chain resolution, strongest evidence first ---------------------------
  function resolveChain(addr: string, family: "evm" | "solana"):
      { chain: string; via: ChainVia; maybePair?: boolean } {
    const candidates = Object.entries(CHAINS).filter(([, c]) => c.family === family);
    const addrLower = addr.toLowerCase();

    // 1. A URL containing BOTH this address and a chain hint
    for (const url of urls) {
      const u = url.toLowerCase();
      if (!u.includes(addrLower)) continue;
      const hit = candidates.find(([, c]) => c.urlHints.some((h) => u.includes(h)));
      if (hit) {
        // dexscreener paths usually carry the PAIR address, not the token —
        // downstream can resolve it via their pairs API before trusting it
        return { chain: hit[0], via: "url+address", maybePair: u.includes("dexscreener.com/") };
      }
    }
    // 2. Any chain URL anywhere in the message
    const urlHit = candidates.find(([, c]) => c.urlHints.some((h) => lower.includes(h)));
    if (urlHit) return { chain: urlHit[0], via: "url" };

    // 3. Explicit "Chain: X" label from signal bots
    if (labelName) {
      const lblHit = candidates.find(([, c]) => c.keywords.some((r) => r.test(labelName)));
      if (lblHit) return { chain: lblHit[0], via: "label" };
    }
    // 4. Launchpad vanity suffix on the address itself
    const sufHit = candidates.find(([, c]) => c.suffixes.some((r) => r.test(addr)));
    if (sufHit) return { chain: sufHit[0], via: "suffix" };

    // 5. Keyword mention — only when exactly one chain in the family matches
    const kwHits = candidates.filter(([, c]) => c.keywords.some((r) => r.test(haystack)));
    if (kwHits.length === 1) return { chain: kwHits[0][0], via: "keyword" };

    // 6. Solana is its own address family, so the format alone is conclusive
    if (family === "solana") return { chain: "SOL", via: "format" };
    return { chain: "EVM_UNKNOWN", via: "none" };
  }

  // ---- Addresses ------------------------------------------------------------
  const seen = new Set<string>();
  const addresses: PrefilterAddress[] = [];

  for (const a of haystack.match(EVM_RE) ?? []) {
    const key = a.toLowerCase();                   // EVM is case-insensitive
    if (seen.has(key)) continue;
    seen.add(key);
    addresses.push({ address: a, family: "evm", ...resolveChain(a, "evm") });
  }
  for (const a of haystack.match(SOL_RE) ?? []) {
    if (seen.has(a) || !isSolPubkey(a)) continue;  // case-sensitive + 32-byte check
    seen.add(a);
    addresses.push({ address: a, family: "solana", ...resolveChain(a, "solana") });
  }

  // ---- Tickers --------------------------------------------------------------
  const tickers = [...new Set(haystack.match(TICKER_RE) ?? [])];

  // ---- Market cap -----------------------------------------------------------
  const mcapMatch = haystack.match(MCAP_RE);
  const MULT: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
  let mcap: number | null = null;
  if (mcapMatch) {
    const n = parseFloat(mcapMatch[1].replace(/,/g, ""));
    const v = n * (MULT[mcapMatch[2]?.toLowerCase() ?? ""] ?? 1);
    mcap = Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  }

  // ---- Known templates ------------------------------------------------------
  // Matched against the message's OWN text, not the reply haystack
  let template: TemplateMatch | null = null;
  for (const t of TEMPLATES) {
    const m = text.match(t.re);
    if (!m) continue;
    template = { name: t.name, ...t.build(m) };
    for (const x of t.extras ?? []) {
      const em = text.match(x.re);
      if (em) Object.assign(template, x.map(em));
    }
    break;
  }
  // A template's ticker capture beats TICKER_RE (which can miss odd scripts)
  if (template?.ticker && !tickers.includes(template.ticker)) tickers.push(template.ticker);

  // ---- Routing --------------------------------------------------------------
  // exitOrUpdate tests the message's OWN text only; words in a quoted original
  // call must not mark the reply as an update.
  const exitOrUpdate = EXIT_UPDATE_RE.test(text);
  const isReplyToSignal = !!reply && exitOrUpdate;

  const structured =
    (!!template && addresses.length <= 1) ||       // template supplies kind + fields
    (addresses.length === 1 &&
      STRUCTURED_VIA.includes(addresses[0].via) &&
      mcap !== null &&
      tickers.length <= 1 &&
      !exitOrUpdate);

  const hasSignal =
    addresses.length > 0 || tickers.length > 0 || isReplyToSignal || !!template;

  const route: PrefilterResult["route"] =
    !hasSignal ? "drop" : structured ? "structured" : "llm";

  // Why a message didn't take the fast path — drives regex/template tuning
  function explainRoute(): string {
    if (!hasSignal) return "no_signal";
    if (template) return `template:${template.name}`;
    if (structured) return "structured";
    if (addresses.length === 0) return isReplyToSignal ? "reply_no_address" : "no_address";
    if (addresses.length > 1) return "multi_address";
    if (!STRUCTURED_VIA.includes(addresses[0].via)) return `weak_chain:${addresses[0].via}`;
    if (mcap === null) return "no_mcap";
    if (tickers.length > 1) return "multi_ticker";
    if (exitOrUpdate) return "exit_or_update_language";
    return "unknown";
  }

  return {
    text,
    hiddenUrls,
    addresses,
    tickers,
    mcap,
    exitOrUpdate,
    isReplyToSignal,
    template,
    fastKind: template?.kind ?? (structured ? "call" : null),
    structured,
    route,
    routeReason: explainRoute(),
  };
}