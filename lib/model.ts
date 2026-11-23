// Launch Radar model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// What the board is. Every protocol the snapshot carries that records no token yet and is not a
// wrapped, staked or bridged product of one that already trades, ranked by an implied value: what a
// launch would be worth if the protocol's record stayed as it is. The snapshot's watchlist (no token
// recorded, at or above the $50M floor, the house's product screen passed) is the floor of the board,
// never its ceiling: the same product screen is applied at every size, so the board also carries the
// early protocols below the floor that the radar exists to find. Protocols whose token already
// trades are never ranked; the dashboard shows them apart, at the market's own values, as the
// comparison set the model is calibrated on.
//
// How an implied value is built, from the snapshot's own figures only:
//
//   implied = TVL x categoryMultiple x growthFactor x seasoningFactor x breadthFactor
//
// - categoryMultiple is learned from the snapshot itself: for each category, the median
//   market-cap/TVL ratio of the protocols in that category whose token already trades, shrunk
//   toward the universe-wide median by the count of traded peers (a category with two traded
//   protocols barely moves off the universe median; one with fifteen stands on its own), then
//   clamped to [0.03, 2.0]. No category is priced by hand and no protocol name is special-cased.
// - growthFactor = 1 + clamp(change_7d, -50, +100) / 100 x 0.6, so a protocol whose TVL grew 50%
//   in a week is priced 30% above its static multiple and one that shrank 50% is priced 30% below.
//   An unreported change counts as no change.
// - seasoningFactor = 0.75 + 0.35 x min(age_days, 1460) / 1460: a protocol that has run four years
//   with no token recorded carries a full track record and is priced at 1.10; a brand-new one at
//   0.75. An unreported listing date counts as one year.
// - breadthFactor = 1 + 0.04 x min(chains - 1, 5): each extra chain a protocol's TVL is counted on
//   adds distribution a launch would inherit, capped at +20%.
//
// Every factor of every row is written into board.json and shown in the dashboard's detail view, so
// a reader can rebuild any row's number from the snapshot by hand.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
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

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** The model's fixed constants. Category prices are NOT here: they are learned per snapshot. */
export const MODEL = {
  version: 'launch-radar-2',
  shrink_peers: 6, // traded peers at which a category's own median gets half the weight
  ratio_floor: 0.005, // a traded peer's mcap/TVL is clamped into this band before any median
  ratio_cap: 5,
  multiple_floor: 0.03, // the learned category multiple is clamped into this band
  multiple_cap: 2.0,
  growth_weight: 0.6,
  growth_floor_pct: -50,
  growth_cap_pct: 100,
  seasoning_base: 0.75,
  seasoning_range: 0.35,
  seasoning_days: 1460,
  unknown_age_days: 365,
  breadth_per_chain: 0.04,
  breadth_max_extra_chains: 5,
};

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One category's learned price: its traded peers' median mcap/TVL, shrunk toward the universe median. */
export interface CategoryPrice {
  peers: number;
  peer_median: number | null;
  multiple: number;
}

/**
 * The price book: what one dollar of TVL is worth at launch, per category, learned from the
 * snapshot's own traded protocols. `overall` is the universe-wide median ratio and the fallback for
 * a category with no traded peers (or no category at all).
 */
export function priceBook(snapshot: Snapshot): { overall: number; byCategory: Map<string, CategoryPrice> } {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = clamp(p.mcap_usd / p.tvl_usd, MODEL.ratio_floor, MODEL.ratio_cap);
    all.push(ratio);
    if (p.category !== null) {
      const list = ratiosByCategory.get(p.category) ?? [];
      list.push(ratio);
      ratiosByCategory.set(p.category, list);
    }
  }
  const overall = all.length > 0 ? median(all) : 0.15;
  const byCategory = new Map<string, CategoryPrice>();
  for (const [category, ratios] of ratiosByCategory) {
    const peerMedian = median(ratios);
    const multiple = clamp(
      (ratios.length * peerMedian + MODEL.shrink_peers * overall) / (ratios.length + MODEL.shrink_peers),
      MODEL.multiple_floor,
      MODEL.multiple_cap,
    );
    byCategory.set(category, { peers: ratios.length, peer_median: round4(peerMedian), multiple: round4(multiple) });
  }
  return { overall: round4(overall), byCategory };
}

/** The multiple one protocol is priced at, and the evidence behind it. */
export function multipleFor(p: SnapshotProtocol, book: { overall: number; byCategory: Map<string, CategoryPrice> }): CategoryPrice {
  if (p.category !== null) {
    const priced = book.byCategory.get(p.category);
    if (priced !== undefined) return priced;
  }
  return { peers: 0, peer_median: null, multiple: book.overall };
}

/** The four factors of one protocol's implied value, and the value itself. */
export interface Valuation {
  implied: number;
  multiple: number;
  peers: number;
  growth_pct: number | null;
  growth_factor: number;
  seasoning_factor: number;
  breadth_factor: number;
  age_days: number | null;
}

/** Price one pre-token protocol from its own record. The same function prices every row. */
export function valueProtocol(p: SnapshotProtocol, asOf: string, book: { overall: number; byCategory: Map<string, CategoryPrice> }): Valuation {
  const price = multipleFor(p, book);
  const age = ageDays(asOf, p.listed_at);
  const growthPct = p.change_7d === null ? null : clamp(p.change_7d, MODEL.growth_floor_pct, MODEL.growth_cap_pct);
  const growthFactor = 1 + ((growthPct ?? 0) / 100) * MODEL.growth_weight;
  const ageForModel = age ?? MODEL.unknown_age_days;
  const seasoningFactor = MODEL.seasoning_base + (Math.min(Math.max(ageForModel, 0), MODEL.seasoning_days) / MODEL.seasoning_days) * MODEL.seasoning_range;
  const breadthFactor = 1 + MODEL.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_max_extra_chains);
  const implied = Math.max(1, Math.round(p.tvl_usd * price.multiple * growthFactor * seasoningFactor * breadthFactor));
  return {
    implied,
    multiple: price.multiple,
    peers: price.peers,
    growth_pct: growthPct === null ? null : round4(growthPct),
    growth_factor: round4(growthFactor),
    seasoning_factor: round4(seasoningFactor),
    breadth_factor: round4(breadthFactor),
    age_days: age,
  };
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are products of another protocol, never a launch of their own. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whole words that mark a wrapped or staked product in a name. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a product may begin with. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * The board's screen, the watchlist's own rule applied at every size: records no token, and is not
 * a wrapped, staked or bridged product of a protocol whose token already trades.
 */
export function passesScreen(p: SnapshotProtocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Farm plans. Every plan is generated from the protocol's own record: its
// category picks the actions, its main chain prices the gas, its TVL sizes
// the position and its age sets the hold. No plan is written for a name.
// ---------------------------------------------------------------------------

/** What one on-chain action costs on a chain, in dollars, as the dashboard states it. */
const CHAIN_ACTION_USD: Record<string, number> = {
  Ethereum: 16,
  Solana: 0.1,
  'BNB Chain': 0.5,
  Bitcoin: 4,
  Tron: 1.2,
  Sui: 0.05,
  Aptos: 0.05,
  TON: 0.1,
};

/** The gas class of a chain the table does not name: layer-2s and sidechains are cheap, the rest mid. */
function actionCostUsd(chain: string): number {
  const named = CHAIN_ACTION_USD[chain];
  if (named !== undefined) return named;
  if (/(arbitrum|base|optimism|zksync|linea|scroll|starknet|polygon|avalanche|mantle|blast|mode|taiko|manta|gnosis|fantom|moonbeam|celo|aurora|metis|boba)/i.test(chain)) return 0.8;
  return 2;
}

const money = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2).replace(/\.?0+$/, '')}`);

/** The first chain a protocol names, or a neutral phrase. */
function mainChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position carries, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 300;
  if (p.tvl_usd >= 250_000_000) return 200;
  if (p.tvl_usd >= 50_000_000) return 120;
  return 60;
}

/** How long a position must be held to count in more than a few snapshots, from the protocol's age. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 75;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The plan's shape for one protocol: its core action, its second action, and its weekly action. */
interface PlanShape {
  open: string;
  second: string;
  weekly: string;
}

/** The category family's actions, in words a farmer can follow. Capital and chain are filled in. */
function planShape(p: SnapshotProtocol, capital: number, chain: string): PlanShape {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('dex'))
    return {
      open: `Swap ${money(capital / 2)} of ETH or USDC into the other side of ${n}'s deepest pool on ${chain}, then add the pair as liquidity and keep the LP position open`,
      second: `Route two more swaps a week through ${n} itself rather than an aggregator, so the volume is recorded under your wallet`,
      weekly: `Make one swap of about ${money(Math.max(10, capital / 10))} through ${n} and rebalance the LP position if it drifts out of range`,
    };
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return {
      open: `Supply ${money(capital)} of USDC to ${n} on ${chain} as collateral and borrow about ${money(Math.round(capital * 0.4))} against it, keeping the health factor above 2`,
      second: `Repay and re-borrow once so both sides of the market carry your wallet's history, then settle back into the supplied position`,
      weekly: `Make one small supply or repayment of about ${money(Math.max(10, capital / 20))} so the account shows a fresh action every week`,
    };
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('option') || c.includes('interest rate'))
    return {
      open: `Deposit ${money(capital)} of USDC as margin on ${n} and open one small hedged pair: long and short the same market in equal size`,
      second: `Close and reopen the pair once a week so trading volume accrues without directional risk beyond the funding spread`,
      weekly: `Trade about ${money(Math.max(20, capital / 5))} of notional in small clips and keep the margin topped up above liquidation distance`,
    };
  if (c.includes('chain'))
    return {
      open: `Bridge ${money(capital)} of USDC onto ${n} through its canonical bridge and hold it in a wallet you control on the chain itself`,
      second: `Use three different apps live on ${n} in the first week: one swap, one lending deposit and one NFT or name mint if the chain offers one`,
      weekly: `Make two ordinary transactions a week on ${n} (a swap and a transfer between your own wallets count) so the wallet ages as a real user`,
    };
  if (c.includes('prediction'))
    return {
      open: `Fund ${money(capital)} on ${n} and take a position in its two most liquid markets, sized so neither can lose more than a fifth of the deposit`,
      second: `Settle one market to completion so a full trade cycle, open to payout, is recorded under your wallet`,
      weekly: `Place one small position in a newly listed market each week rather than churning the same market`,
    };
  if (c.includes('rwa'))
    return {
      open: `Complete ${n}'s onboarding or allowlist step if it runs one, then mint ${money(capital)} of its yield asset on ${chain} and hold the position`,
      second: `Hold through one full distribution or interest period so a payout lands in your wallet from the position itself`,
      weekly: `Check the position and reinvest any distribution once a week, about ten minutes, rather than letting it sit idle`,
    };
  if (c.includes('privacy'))
    return {
      open: `Deposit ${money(capital)} into ${n} on ${chain} from a fresh wallet and make one shielded transfer to a second wallet of your own`,
      second: `Withdraw part of the position after a week so a deposit, a private transfer and a withdrawal are all recorded`,
      weekly: `Make one shielded transaction a week; privacy pools reward time in the pool, so leave the rest untouched`,
    };
  if (c.includes('insurance'))
    return {
      open: `Buy ${money(capital)} of cover from ${n} on ${chain} against a position you actually hold, and keep the policy to its term`,
      second: `Stake a smaller amount into ${n}'s risk pool if it offers one, so you appear on both sides of the market`,
      weekly: `Renew or extend one cover line each week so coverage never lapses in the record`,
    };
  if (c.includes('staking') || c.includes('restak'))
    return {
      open: `Stake ${money(capital)} of the chain's staking asset through ${n} on ${chain} and keep the receipt token in the same wallet`,
      second: `Claim and restake the first reward payment so the compounding is recorded under your wallet`,
      weekly: `Add a small top-up of about ${money(Math.max(10, capital / 20))} or claim rewards once a week to keep the position visibly active`,
    };
  if (c.includes('payment') || c.includes('card'))
    return {
      open: `Open a ${n} account, complete the identity check it requires, and load ${money(capital)} so the account is funded and usable`,
      second: `Make two real payments through ${n} in the first week, however small, so the account reads as a user's and not a squatter's`,
      weekly: `Route one ordinary payment a week through ${n} and keep a small balance parked in the account`,
    };
  // Vaults, yield, curators, allocators, indexes, basis and farming categories, and the default.
  return {
    open: `Deposit ${money(capital)} of USDC into ${n}'s main vault or pool on ${chain} and keep the shares in the depositing wallet`,
    second: `Withdraw a tenth of the position after the first week and deposit it again, so a full deposit-withdraw-deposit cycle is recorded`,
    weekly: `Make one small deposit of about ${money(Math.max(10, capital / 20))} each week and claim any rewards the vault pays into the same wallet`,
  };
}

/**
 * A protocol's farm plan: seven steps, each an action with its cost and its time, derived from the
 * protocol's own category, main chain, TVL and age. Costs are the model's stated gas figures, not a
 * quote: they are printed in the dashboard beside the model so a reader can price them their own way.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): string[] {
  const chain = mainChain(p);
  const gas = actionCostUsd(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const shape = planShape(p, capital, chain);
  const weeks = Math.max(4, Math.round(hold / 7));
  const steps = [
    `Set up a fresh wallet that holds only the funds for this farm, write its seed phrase on paper and keep it offline; never farm from a wallet that holds your savings. Cost: no fee beyond ${money(gas)} of gas for its first transaction on ${chain}. Time: 10 minutes, once.`,
    `Fund the wallet with ${money(capital)} of working capital plus about ${money(gas * 6)} of ${chain} gas money, bridging to ${chain} first if the position lives there. Cost: the ${money(capital)} is your position, not a fee; bridging and approval transactions run about ${money(gas * 3)}. Time: 20 minutes, once.`,
    `${shape.open}. Cost: about ${money(gas * 2)} of gas on ${chain} on top of the capital committed. Time: 15 minutes to set up.`,
    `${shape.second}. Cost: about ${money(gas * 2)} of gas. Time: 15 minutes, in the first week.`,
    `${shape.weekly}. Cost: about ${money(gas)} of gas a week, roughly ${money(gas * weeks)} across the ${weeks}-week qualifying window. Time: 10 minutes a week for ${weeks} weeks.`,
    `Hold the position for at least ${hold} days so the activity spans more than one weekly snapshot, and check ${p.name}'s own announcements page weekly for a points or rewards program; follow only links the protocol itself publishes. Cost: nothing to check, and never pay anyone to claim an airdrop. Time: 5 minutes a week.`,
    `Keep a farm log with the wallet address, every date, transaction and balance, and review it monthly; when a launch is announced, unwind in the order the log records, and expect any claim window to be measured in weeks, not hours. Cost: nothing but the log. Time: 15 minutes a month.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

// ---------------------------------------------------------------------------
// The board and the dashboard's data.
// ---------------------------------------------------------------------------

/** One row of board.json: the ranked board's row, with the model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  token_status: 'records-no-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_peers: number;
    growth_pct: number | null;
    growth_factor: number;
    seasoning_factor: number;
    breadth_factor: number;
  };
  farm_steps: string[];
}

/** A protocol whose token already trades: shown apart, at the market's own value, never ranked. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  ratio: number | null;
}

/** The dashboard's row: the board row plus its farm plan, as board.json carries it. */
export interface RadarRow extends BoardRow {
  farm_steps: string[];
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  overall_multiple: number;
  protocol_count: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  category_prices: { category: string; peers: number; peer_median: number | null; multiple: number }[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** How many already-trading protocols the dashboard's comparison view carries, by market cap. */
export const LIVE_ROWS = 30;

/** The ranked board: every screened protocol, strongest implied value first, ranks 1..n. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const book = priceBook(snapshot);
  const onWatchlist = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(passesScreen)
    .map((p) => ({ p, v: valueProtocol(p, snapshot.as_of, book) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    token_status: 'records-no-token',
    watchlist: onWatchlist.has(s.p.slug),
    age_days: s.v.age_days,
    implied_value_usd: s.v.implied,
    model: {
      category_multiple: s.v.multiple,
      category_peers: s.v.peers,
      growth_pct: s.v.growth_pct,
      growth_factor: s.v.growth_factor,
      seasoning_factor: s.v.seasoning_factor,
      breadth_factor: s.v.breadth_factor,
    },
    farm_steps: farmPlan(s.p, s.v.age_days),
  }));
}

/** The already-trading comparison set, by market cap. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !recordsNoToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the program writes: the board for board.json and the data for the dashboard. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const book = priceBook(snapshot);
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL.version,
    overall_multiple: book.overall,
    protocol_count: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.watchlist).length,
    live_size: live.length,
    category_prices: [...book.byCategory.entries()]
      .map(([category, price]) => ({ category, peers: price.peers, peer_median: price.peer_median, multiple: price.multiple }))
      .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1)),
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: size, coverage, ranks, order, values, steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears on the board more than once';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is held by ${byRank[i]!.slug} with rank ${byRank[i]!.rank}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `${byRank[i]!.slug} outranks ${byRank[i - 1]!.slug} on implied value`;
  }
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row carries the same implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const trimmed = s.trim();
      if (trimmed.length < 20 || trimmed.length > 600) return `${r.slug} has a farm step of ${trimmed.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
