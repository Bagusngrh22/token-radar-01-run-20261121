// Token Radar, model radar-3 — written in this session.
// One sealed snapshot in, one ranked board out. Nothing here names a
// protocol in advance: every number below is derived from the snapshot
// itself, and the same scoring function runs over every candidate.
//
// How a protocol earns its implied value
//   market multiple: for each category, the median (market cap / TVL) of
//     the protocols in that category that already trade, read from this
//     snapshot. A thin category (fewer than 5 live names) borrows the
//     snapshot-wide median instead. Clamped to [0.05, 1.00].
//   reach: 1 + 0.02 for each chain beyond the first, capped at 5 extra.
//   momentum: 1 + 0.5 * clamp(change_7d, -60, +120) / 100.
//   staying power: 0.60 + 0.40 * min(age_days, 1095) / 1095; a protocol
//     with no listing date is scored as 365 days old.
//   implied = round(TVL * market multiple * reach * momentum * staying power)
// A protocol is rankable when the snapshot records no token for it
// (mcap, gecko id and symbol all null), it is not a CEX, and its name
// does not end in a version marker. Live-token protocols are never
// ranked; the 24 largest by market cap are shown separately, at the
// market's own price, so the board never mixes a model's guess with a
// traded value.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelTuning {
  momentumWeight: number;
  growthLow: number;
  growthHigh: number;
  stayingBase: number;
  stayingSpan: number;
  stayingDays: number;
  ageWhenUnknown: number;
  reachPerChain: number;
  reachCapChains: number;
  multipleLow: number;
  multipleHigh: number;
  minLiveForOwnMultiple: number;
}

export const TUNING: ModelTuning = {
  momentumWeight: 0.5,
  growthLow: -60,
  growthHigh: 120,
  stayingBase: 0.6,
  stayingSpan: 0.4,
  stayingDays: 1095,
  ageWhenUnknown: 365,
  reachPerChain: 0.02,
  reachCapChains: 5,
  multipleLow: 0.05,
  multipleHigh: 1.0,
  minLiveForOwnMultiple: 5,
};

export const MODEL_VERSION = "radar-3";
export const LIVE_SHOWN = 24;
/** No cap on early rows: every rankable pre-token protocol below the floor joins the board. */
export const EARLY_CAP = 400;

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: "pre-token";
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    chain_multiplier: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
  tvl_rank: number;
  on_watchlist: boolean;
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  category_multiple: number;
  chain_multiplier: number;
  tvl_rank: number;
  on_watchlist: boolean;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelTuning;
  model_version: string;
  category_multiples: Record<string, number>;
  global_multiple: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Whole days from listed_at to as_of, or null when either date is missing. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

function middle(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Market multiple per category, from this snapshot alone: median
 * market-cap / TVL among live-token protocols of that category.
 * Thin categories fall back to the snapshot-wide median.
 */
export function categoryMultiples(
  snap: Snapshot,
  tune: ModelTuning,
): { byCategory: Record<string, number>; global: number } {
  const perCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snap.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    if (p.category === null || p.category === "CEX") continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const bucket = perCategory.get(p.category) ?? [];
    bucket.push(ratio);
    perCategory.set(p.category, bucket);
  }
  const global = clamp(middle(all, 0.25), tune.multipleLow, tune.multipleHigh);
  const byCategory: Record<string, number> = {};
  for (const cat of [...perCategory.keys()].sort()) {
    const ratios = perCategory.get(cat)!;
    byCategory[cat] =
      ratios.length >= tune.minLiveForOwnMultiple
        ? clamp(middle(ratios, global), tune.multipleLow, tune.multipleHigh)
        : global;
  }
  return { byCategory, global };
}

/**
 * One line a reader can check: every factor that went into a row's
 * implied value, in the order the formula multiplies them.
 */
export function explainScore(
  p: SnapshotProtocol,
  asOf: string,
  tune: ModelTuning,
  multiples: { byCategory: Record<string, number>; global: number },
): string {
  const s = scoreProtocol(p, asOf, tune, multiples);
  return (
    `${p.name}: TVL $${p.tvl_usd.toLocaleString("en-US")} x category ${s.catMult.toFixed(4)}` +
    ` x chains ${s.chainMult.toFixed(2)} x growth ${s.growthMult.toFixed(4)}` +
    ` x maturity ${s.maturityMult.toFixed(4)} = $${s.implied.toLocaleString("en-US")}`
  );
}

export function chainMultiplier(p: SnapshotProtocol, tune: ModelTuning): number {
  const extra = clamp(p.chains.length - 1, 0, tune.reachCapChains);
  return 1 + tune.reachPerChain * extra;
}

export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  tune: ModelTuning,
  multiples: { byCategory: Record<string, number>; global: number },
): {
  implied: number;
  catMult: number;
  chainMult: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, p.listed_at);
  const growthPct = clamp(asNumber(p.change_7d, 0), tune.growthLow, tune.growthHigh);
  const growthMult = 1 + (growthPct / 100) * tune.momentumWeight;
  const ageForScore = age ?? tune.ageWhenUnknown;
  const maturityMult =
    tune.stayingBase +
    (clamp(ageForScore, 0, tune.stayingDays) / tune.stayingDays) * tune.stayingSpan;
  const catMult =
    p.category !== null && multiples.byCategory[p.category] !== undefined
      ? multiples.byCategory[p.category]!
      : multiples.global;
  const chainMult = chainMultiplier(p, tune);
  const implied = Math.max(
    1,
    Math.round(p.tvl_usd * catMult * chainMult * growthMult * maturityMult),
  );
  return { implied, catMult, chainMult, growthPct, growthMult, maturityMult, age };
}

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== "CEX" && !VERSIONED_NAME.test(p.name);
}

function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

function byTvl(a: SnapshotProtocol, b: SnapshotProtocol): number {
  return b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

/** Rank the watchlist plus every rankable pre-token protocol below the floor, by implied value. */
export function buildBoard(snap: Snapshot, tune: ModelTuning = TUNING): BoardRow[] {
  const index = bySlug(snap.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snap.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snap.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snap.floor_usd)
    .sort(byTvl)
    .slice(0, EARLY_CAP);
  for (const p of early) chosen.set(p.slug, p);

  const multiples = categoryMultiples(snap, tune);
  const tvlRank = new Map<string, number>();
  [...snap.protocols].sort(byTvl).forEach((p, i) => tvlRank.set(p.slug, i + 1));

  const scored = [...chosen.values()].map((p) => ({
    p,
    ...scoreProtocol(p, snap.as_of, tune, multiples),
  }));
  scored.sort(
    (a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: "pre-token" as const,
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: s.catMult,
      chain_multiplier: round4(s.chainMult),
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
    tvl_rank: tvlRank.get(s.p.slug) ?? 0,
    on_watchlist: snap.watchlist.includes(s.p.slug),
  }));
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function mainChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : "its main chain";
}

function stakeSize(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

function holdDays(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The one core action for a category, in words a farmer can follow. */
function coreAction(p: SnapshotProtocol, size: number, chain: string): string {
  const c = (p.category ?? "").toLowerCase();
  const name = p.name;
  if (c.includes("lend") || c.includes("cdp") || c.includes("collateral"))
    return `Lend $${size} of USDC on ${name} (${chain}) and leave the supply position open.`;
  if (c.includes("dex") || c.includes("yield") || c.includes("leveraged farm"))
    return `Add $${size} of liquidity to the main ${name} pool on ${chain} and keep it in range.`;
  if (c.includes("bridge"))
    return `Bridge $${size} of USDC into ${chain} through ${name}, then use the bridged funds inside its app.`;
  if (c.includes("staking") || c.includes("restak"))
    return `Stake $${size} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes("perpetual") || c.includes("derivative"))
    return `Post $${size} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes("prediction"))
    return `Fund $${size} on ${name} and take one position in an active market.`;
  if (c.includes("curator") || c.includes("allocator"))
    return `Deposit $${size} into a ${name} vault on ${chain} and hold the vault shares.`;
  if (c.includes("stable"))
    return `Mint or deposit $${size} of the stable asset through ${name} on ${chain}.`;
  if (c.includes("rwa"))
    return `Mint $${size} of the yield-bearing asset on ${name} (${chain}) and hold it.`;
  if (c.includes("insurance"))
    return `Buy $${size} of cover from ${name} on ${chain} and keep the policy active.`;
  return `Deposit $${size} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * Seven farm steps, derived only from the protocol's own record
 * (category, chains, TVL, age). Every step states its cost and time.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = mainChain(p);
  const size = stakeSize(p);
  const hold = holdDays(age);
  const gas = size >= 150 ? 8 : 4;
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline on paper.`,
      cost: "under $3 of gas for the first transaction",
      time: "5 minutes",
    },
    { text: coreAction(p, size, chain), cost: `$${size} of capital and about $${gas} of gas`, time: "15 minutes to set up" },
    {
      text: `Return once a week and do one real action — a deposit, a borrow, a swap or a vote — so the wallet reads as active, not dormant.`,
      cost: "about $2 of gas a week",
      time: "10 minutes a week",
    },
    {
      text: `Keep the position open for at least ${hold} days, so it is counted in more than one snapshot of activity.`,
      cost: `the $${size} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Check the protocol's own points or rewards page before you move anything, and claim only from a link that page itself publishes.`,
      cost: "no fee to check, and never pay to claim",
      time: "10 minutes",
    },
    {
      text: `Log the wallet, the dates and every transaction hash, so you can repeat the position or unwind it cleanly later.`,
      cost: "nothing but the log",
      time: "5 minutes",
    },
    {
      text: `Re-check the radar each week: if TVL falls more than 30% in 7 days, unwind half the position; if a token appears, claim only from the protocol's own page.`,
      cost: "nothing but the check",
      time: "5 minutes a week",
    },
  ];
}

export function liveRows(snap: Snapshot): LiveRow[] {
  return snap.protocols
    .filter((p) => !isPreToken(p) && p.category !== "CEX")
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_SHOWN)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    category_multiple: row.model.category_multiple,
    chain_multiplier: row.model.chain_multiplier,
    tvl_rank: row.tvl_rank,
    on_watchlist: row.on_watchlist,
  };
}

export function buildRadar(
  snap: Snapshot,
  tune: ModelTuning = TUNING,
): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snap, tune);
  const live = liveRows(snap);
  const multiples = categoryMultiples(snap, tune);
  const radar: RadarData = {
    as_of: snap.as_of,
    source: snap.source,
    floor_usd: snap.floor_usd,
    model: tune,
    model_version: MODEL_VERSION,
    category_multiples: multiples.byCategory,
    global_multiple: multiples.global,
    watchlist_size: snap.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !snap.watchlist.includes(r.slug)).length,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError("snapshot.json is not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new SnapshotError("snapshot.json is not a JSON object");
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of))
    throw new SnapshotError("snapshot.json has no as_of date");
  if (typeof o.source !== "string") throw new SnapshotError("snapshot.json has no source");
  if (typeof o.floor_usd !== "number" || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0)
    throw new SnapshotError("snapshot.json has no floor_usd");
  if (!Array.isArray(o.protocols)) throw new SnapshotError("snapshot.json has no protocols array");
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== "string"))
    throw new SnapshotError("snapshot.json has no watchlist of slugs");
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== "object" || v === null || Array.isArray(v))
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (
      typeof p.slug !== "string" ||
      typeof p.name !== "string" ||
      typeof p.tvl_usd !== "number" ||
      !Number.isFinite(p.tvl_usd)
    )
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === "string" ? p.category : null,
      chains: Array.isArray(p.chains)
        ? p.chains.filter((c): c is string => typeof c === "string")
        : [],
      tvl_usd: p.tvl_usd,
      change_7d:
        typeof p.change_7d === "number" && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd:
        typeof p.mcap_usd === "number" && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === "string" ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === "string" ? p.gecko_id : null,
      symbol: typeof p.symbol === "string" ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** The gate's own checks, in miniature: null when this board would pass them. */
export function boardIssue(board: BoardRow[], snap: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snap.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0)
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? "" : "s"}: ${missing.slice(0, 5).join(", ")}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++)
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++)
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd)
      return `row ${i + 1} outranks row ${i} on implied value`;
  if (
    board.length >= 2 &&
    board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd
  )
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}`;
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12)
      return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps)
      if (s.length < 20 || s.length > 600)
        return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0)
      return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
