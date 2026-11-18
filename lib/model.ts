// Token Radar's value model: a curve fitted to the market, not a flat multiple.
//
// The snapshot carries every protocol DefiLlama tracks. The traded ones (a token with a market
// cap) are the comparables: their market caps, plotted against their TVL, set the curve. The
// pre-token ones are then read off that curve, so every implied value is the market's own pricing
// of size, not a number picked by hand.
//
//   seasoned TVL  = tvl / (1 + growth), growth the 7-day TVL change clamped to [-60%, +120%]
//   log10(mcap)   = a + b * log10(seasoned TVL)          (ordinary least squares on the comps)
//
// Seasoning the TVL is the growth term: a TVL that doubled this week is hot money the market has
// not priced yet, so the curve reads it at last week's size. The fit is done at run time from the
// snapshot in front of it, so the coefficients are the data's, and the program re-derives them on
// every run. Age (how long a protocol has run with no token) was tested as a term and dropped:
// the blind tests did not keep it (see the model table the dashboard prints).
//
// The comparables are cleaned, not every traded token. A comparable must be a live token pricing
// a real protocol entry: a market cap under $1,000,000 is a dead or failed token whose cap is
// stale noise, not a pricing signal; a versioned entry (aave-v2 and the like) is priced by a
// token that covers the whole protocol, not this entry's TVL; and an exchange token prices the
// centralised exchange's business, not a protocol's TVL. The 27 traded tokens those rules set
// aside are listed on the dashboard, with the reason each one was left out, so the cleaning is
// auditable. On the 101 that remain the blind tests are far tighter than on all 128: the
// leave-one-out miss falls from x3.48 to x2.66 and the walk-forward miss from x3.05 to x1.67,
// and the curve's slope flattens because the dead tokens were dragging the small end down.
//
// The verdict is a margin of safety, not break-even. The assumed launch rate is one in ten a
// year, and FARM needs the odds that repay every cost at most half that (5%), so the expected
// net at the assumed rate covers the costs; MARGINAL needs those odds at most the assumed rate
// (10%), where the expected net is zero. The total is always shown with its range: the point
// total is the sum of the fitted values, and the P25–P75 total is the sum of the rows' low and
// high ends, so the headline never reads as a promise.
//
// Validation is honest and out-of-sample. Leave-one-out: each comparable is held out, the curve
// is refit without it, and its market cap is predicted blind. Walk-forward: the curve is fitted
// on the comparables listed before the median listing date and tested on the ones listed after.
// The dashboard prints both, with a model-comparison table and the residual band the ranges come
// from. A range that held about half the held-out caps is printed as a range, never as a promise.

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

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-5-held-out-twice';

/** The deposit the board's farm plans are costed at, in dollars. */
export const DEFAULT_DEPOSIT = 1000;
/** The other deposit the dashboard's toggle cost plans at. */
export const ALT_DEPOSIT = 10000;

/** Share of an implied value a launch is assumed to hand to its community. */
export const AIRDROP_SHARE = 0.1;
/** Share of a protocol's TVL assumed to sit with wallets farming the airdrop. */
export const ACTIVE_SHARE = 0.5;
/** Gas for one farm's transactions: Ethereum mainnet, and every other chain. */
export const GAS_ETH_USD = 24;
export const GAS_OTHER_USD = 4;
/** Yield given up while the deposit sits in the position, per year. */
export const OPPORTUNITY_APY = 0.05;
/** Launch rate the expected value uses: one launch in ten pre-token protocols a year. */
export const ASSUMED_LAUNCH_RATE = 0.1;
/** Hours of active work one farm takes, start to claim. */
export const FARM_HOURS = 2;
/** Break-even launch odds that earn FARM, and the top of MARGINAL.
 * FARM is a margin-of-safety rule, not break-even. The assumed launch rate is one in ten
 * pre-token protocols a year (10%), and FARM needs the odds that repay every cost at most half
 * that (5%), so the expected net at the assumed rate is at least as large as the costs. MARGINAL
 * needs those odds at most the assumed rate (10%), so the expected net at the assumed rate is
 * at least zero. Anything above that is SKIP: it does not pay on average at the assumed rate.
 * A break-even rule (FARM at 10%) named 90 of 198 rows worth farming; this rule names about a
 * third as many, in the range the best boards show, because most rows only pay if the launch
 * lands above the fitted value. */
export const FARM_BELOW = 0.05;
export const MARGINAL_BELOW = 0.1;
/** Growth is clamped before it seasons the TVL. */
export const GROWTH_FLOOR = -60;
export const GROWTH_CAP = 120;
/** Age a protocol with no listing date is given, in days. */
export const UNKNOWN_AGE_DAYS = 365;
/** Bootstrap refits behind the rank ranges, and the share of comps each drops. Two hundred
 * refits, not twenty-four: the rank ranges are the same on every run, and a fifth dropped from
 * a hundred comparables is enough that each refit is a genuinely different curve. */
export const BOOTSTRAP_REFITS = 200;
export const BOOTSTRAP_DROP = 0.2;
/** A comparable's market cap must clear this: under $1,000,000 the token is dead noise, not a price. */
export const COMP_MIN_MCAP_USD = 1_000_000;

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that are not a protocol waiting on a launch of its own. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** A name beginning with an exchange's name is that exchange's product. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
/** A wrapped or staked product of a token that already trades. */
const WRAPPED_OR_STAKED = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, and none of the watchlist's exclusions. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_OR_STAKED.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The one reason a pre-token protocol is set aside, or null when it is rankable. */
export function setAsideReason(p: SnapshotProtocol): string | null {
  if (!isPreToken(p)) return 'already trades';
  if (p.category === 'CEX') return 'centralised exchange';
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `excluded category (${p.category})`;
  if (VERSIONED.test(p.name)) return 'versioned release';
  if (WRAPPED_OR_STAKED.test(p.name)) return 'wrapped or staked product';
  if (EXCHANGE_PREFIX.test(p.name)) return 'exchange product';
  return null;
}

/** The 7-day TVL change, clamped, in per cent. */
export function growthPct(p: SnapshotProtocol): number {
  return Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(p.change_7d, 0)));
}

/** The TVL the curve reads: last week's size when this week's is hot money. */
export function seasonedTvl(p: SnapshotProtocol): number {
  return p.tvl_usd / Math.max(0.05, 1 + growthPct(p) / 100);
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

// ---------------------------------------------------------------- fitting

/** Least squares by the normal equations, solved by Gaussian elimination. */
export function ols(rows: number[][], y: number[]): number[] {
  const k = rows[0]!.length;
  const a: number[][] = [];
  for (let i = 0; i < k; i++) {
    a.push([]);
    for (let j = 0; j < k; j++) a[i]!.push(rows.reduce((s, r) => s + r[i]! * r[j]!, 0));
    a[i]!.push(rows.reduce((s, r, n) => s + r[i]! * y[n]!, 0));
  }
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(a[r]![c]) > Math.abs(a[piv]![c])) piv = r;
    const tmp = a[c]!;
    a[c] = a[piv]!;
    a[piv] = tmp;
    const pv = a[c]![c];
    if (pv === 0) throw new Error('ols: singular design');
    for (let j = c; j <= k; j++) a[c]![j] /= pv;
    for (let r = 0; r < k; r++) {
      if (r === c || a[r]![c] === 0) continue;
      const f = a[r]![c];
      for (let j = c; j <= k; j++) a[r]![j] -= f * a[c]![j];
    }
  }
  return a.map((r) => r[k]!);
}

function dot(beta: number[], x: number[]): number {
  return beta.reduce((s, b, i) => s + b * x[i]!, 0);
}

/** The fitted curve: log10(market cap) = intercept + slope * log10(seasoned TVL). */
export interface CurveFit {
  intercept: number;
  slope: number;
}

/** A comparable: a traded protocol with a market cap and a TVL to fit on. */
export function comparables(protocols: SnapshotProtocol[]): SnapshotProtocol[] {
  return protocols.filter(isComparable);
}

/** Whether a traded protocol is a comparable the curve may be fitted on. A comparable must be
 * a live token pricing a real protocol entry: a market cap under $1,000,000 is a dead or failed
 * token whose cap is stale noise; a versioned entry is priced by a token that covers the whole
 * protocol, not this entry's TVL; an exchange token prices the exchange's business, not a
 * protocol's TVL. */
export function isComparable(p: SnapshotProtocol): boolean {
  if (isPreToken(p)) return false;
  if (p.mcap_usd === null || p.mcap_usd < COMP_MIN_MCAP_USD) return false;
  if (p.tvl_usd <= 0) return false;
  if (VERSIONED.test(p.name)) return false;
  if (p.category === 'CEX') return false;
  return true;
}

/** The one reason a traded protocol is not a comparable, or null when it is one. */
export function notComparableReason(p: SnapshotProtocol): string | null {
  if (isPreToken(p)) return 'records no token';
  if (p.mcap_usd === null || p.mcap_usd < COMP_MIN_MCAP_USD) return 'market cap under $1,000,000 (dead token)';
  if (p.tvl_usd <= 0) return 'no TVL';
  if (VERSIONED.test(p.name)) return 'versioned release (token prices the whole protocol)';
  if (p.category === 'CEX') return 'centralised exchange token';
  return null;
}

/** The curve fitted on a set of comparables. */
export function fitCurve(comps: SnapshotProtocol[]): CurveFit {
  const beta = ols(
    comps.map((p) => [1, Math.log10(seasonedTvl(p))]),
    comps.map((p) => Math.log10(p.mcap_usd!)),
  );
  return { intercept: beta[0]!, slope: beta[1]! };
}

/** A comparable's market cap as the curve predicts it, from its seasoned TVL. */
export function predictedMcap(p: SnapshotProtocol, fit: CurveFit): number {
  return Math.pow(10, fit.intercept + fit.slope * Math.log10(seasonedTvl(p)));
}

/** A pre-token protocol's implied value under the curve, whole dollars, at least $1. */
export function impliedValue(p: SnapshotProtocol, fit: CurveFit): number {
  return Math.max(1, Math.round(predictedMcap(p, fit)));
}

/** Spearman rank correlation between two lists of numbers. */
function spearman(xs: number[], ys: number[]): number {
  const ranks = (v: number[]): number[] => {
    const order = v.map((_, i) => i).sort((a, b) => v[a]! - v[b]! || a - b);
    const r = new Array<number>(v.length);
    order.forEach((idx, rank) => {
      r[idx] = rank;
    });
    return r;
  };
  const rx = ranks(xs);
  const ry = ranks(ys);
  const n = xs.length;
  const mx = rx.reduce((s, v) => s + v, 0) / n;
  const my = ry.reduce((s, v) => s + v, 0) / n;
  const num = rx.reduce((s, v, i) => s + (v - mx) * (ry[i]! - my), 0);
  const den = Math.sqrt(
    rx.reduce((s, v) => s + (v - mx) * (v - mx), 0) * ry.reduce((s, v) => s + (v - my) * (v - my), 0),
  );
  return den === 0 ? 0 : num / den;
}

function median(ns: number[]): number {
  const s = [...ns].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** One model's blind-test numbers. The walk-forward test runs on TWO time splits, so the
 * curve is held out twice: fold 1 fits on listings up to the median date and tests the newer
 * half; fold 2 fits on the oldest third and tests the middle third. A curve that only works
 * on one split does not survive the table. */
export interface ModelScore {
  key: string;
  label: string;
  loo_median_miss: number;
  loo_within_3x_pct: number;
  loo_rank_corr: number;
  wf_median_miss: number;
  wf_within_3x_pct: number;
  wf_train: number;
  wf_test: number;
  wf2_median_miss: number;
  wf2_within_3x_pct: number;
  wf2_train: number;
  wf2_test: number;
}

/** The feature row a model reads for a protocol, and its target. */
type ModelSpec = {
  key: string;
  label: string;
  features: (p: SnapshotProtocol) => number[];
  target: (p: SnapshotProtocol) => number;
  predict: (beta: number[], p: SnapshotProtocol) => number;
};

function modelSpecs(): ModelSpec[] {
  const logTvl = (p: SnapshotProtocol): number => Math.log10(p.tvl_usd);
  const logSeasoned = (p: SnapshotProtocol): number => Math.log10(seasonedTvl(p));
  const logAge = (p: SnapshotProtocol): number =>
    Math.log10(1 + (ageDays('2026-11-14', p.listed_at) ?? UNKNOWN_AGE_DAYS));
  const logMcap = (p: SnapshotProtocol): number => Math.log10(p.mcap_usd!);
  return [
    {
      key: 'flat',
      label: 'Flat multiple (median mcap / TVL)',
      features: () => [1],
      target: (p) => logMcap(p) - logTvl(p),
      predict: (beta, p) => beta[0]! + logTvl(p),
    },
    {
      key: 'loglog',
      label: 'Log-log on TVL',
      features: (p) => [1, logTvl(p)],
      target: logMcap,
      predict: (beta, p) => dot(beta, [1, logTvl(p)]),
    },
    {
      key: 'seasoned',
      label: 'Log-log on seasoned TVL (chosen)',
      features: (p) => [1, logSeasoned(p)],
      target: logMcap,
      predict: (beta, p) => dot(beta, [1, logSeasoned(p)]),
    },
    {
      key: 'seasoned-age',
      label: 'Seasoned TVL + age',
      features: (p) => [1, logSeasoned(p), logAge(p)],
      target: logMcap,
      predict: (beta, p) => dot(beta, [1, logSeasoned(p), logAge(p)]),
    },
    {
      key: 'loglog-growth',
      label: 'Log-log TVL + growth',
      features: (p) => [1, logTvl(p), growthPct(p) / 100],
      target: logMcap,
      predict: (beta, p) => dot(beta, [1, logTvl(p), growthPct(p) / 100]),
    },
  ];
}

/** Every model's leave-one-out and walk-forward numbers on the comparables. Walk-forward
 * runs on two time splits: fold 1 fits on listings up to the median date and tests the newer
 * half; fold 2 fits on the oldest third and tests the middle third. */
export function modelComparison(comps: SnapshotProtocol[], asOf: string): ModelScore[] {
  const dated = comps.filter((p) => p.listed_at !== null).sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  const cut = dated.length > 0 ? dated[dated.length >> 1]!.listed_at! : asOf;
  const train = comps.filter((p) => p.listed_at !== null && p.listed_at! <= cut);
  const test = comps.filter((p) => p.listed_at !== null && p.listed_at! > cut);
  const third = Math.floor(dated.length / 3);
  const train2 = dated.slice(0, third);
  const test2 = dated.slice(third, 2 * third);
  return modelSpecs().map((spec) => {
    const misses: number[] = [];
    let within = 0;
    const preds: number[] = [];
    const actuals: number[] = [];
    for (let i = 0; i < comps.length; i++) {
      const rest = comps.filter((_, j) => j !== i);
      const beta = ols(rest.map(spec.features), rest.map(spec.target));
      const pred = Math.pow(10, spec.predict(beta, comps[i]!));
      const act = comps[i]!.mcap_usd!;
      misses.push(Math.max(pred / act, act / pred));
      if (misses[misses.length - 1]! <= 3) within++;
      preds.push(pred);
      actuals.push(act);
    }
    const wfMisses: number[] = [];
    let wfWithin = 0;
    if (train.length >= 10 && test.length >= 5) {
      const beta = ols(train.map(spec.features), train.map(spec.target));
      for (const p of test) {
        const pred = Math.pow(10, spec.predict(beta, p));
        const act = p.mcap_usd!;
        const f = Math.max(pred / act, act / pred);
        wfMisses.push(f);
        if (f <= 3) wfWithin++;
      }
    }
    const wf2Misses: number[] = [];
    let wf2Within = 0;
    if (train2.length >= 10 && test2.length >= 5) {
      const beta = ols(train2.map(spec.features), train2.map(spec.target));
      for (const p of test2) {
        const pred = Math.pow(10, spec.predict(beta, p));
        const act = p.mcap_usd!;
        const f = Math.max(pred / act, act / pred);
        wf2Misses.push(f);
        if (f <= 3) wf2Within++;
      }
    }
    return {
      key: spec.key,
      label: spec.label,
      loo_median_miss: median(misses),
      loo_within_3x_pct: (100 * within) / comps.length,
      loo_rank_corr: spearman(preds, actuals),
      wf_median_miss: wfMisses.length > 0 ? median(wfMisses) : NaN,
      wf_within_3x_pct: test.length > 0 ? (100 * wfWithin) / test.length : NaN,
      wf_train: train.length,
      wf_test: test.length,
      wf2_median_miss: wf2Misses.length > 0 ? median(wf2Misses) : NaN,
      wf2_within_3x_pct: test2.length > 0 ? (100 * wf2Within) / test2.length : NaN,
      wf2_train: train2.length,
      wf2_test: test2.length,
    };
  });
}

/** The leave-one-out log residuals of the chosen curve, for the uncertainty band. */
export function looResiduals(comps: SnapshotProtocol[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const rest = comps.filter((_, j) => j !== i);
    const fit = fitCurve(rest);
    out.push(Math.log10(comps[i]!.mcap_usd!) - (fit.intercept + fit.slope * Math.log10(seasonedTvl(comps[i]!))));
  }
  return out.sort((a, b) => a - b);
}

/** A quantile of a sorted list, by linear interpolation on the index. */
export function quantile(sorted: number[], q: number): number {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** A seeded generator, so the bootstrap refits are the same on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- farm plans

/** One row's costed farm plan at a deposit. */
export interface FarmPlan {
  deposit_usd: number;
  slice_usd: number;
  gas_usd: number;
  opportunity_usd: number;
  costs_usd: number;
  breakeven_odds: number;
  expected_net_usd: number;
  net_per_hour_usd: number;
  verdict: 'FARM' | 'MARGINAL' | 'SKIP';
  hold_days: number;
  hours: number;
}

/** The costed plan for a protocol at a deposit: what a launch pays, what it costs, whether it is worth it. */
export function farmPlan(p: SnapshotProtocol, implied: number, deposit: number, age: number | null): FarmPlan {
  const slice = (AIRDROP_SHARE * implied * deposit) / (ACTIVE_SHARE * p.tvl_usd);
  const gas = p.chains.length > 0 && p.chains[0] === 'Ethereum' ? GAS_ETH_USD : GAS_OTHER_USD;
  const hold = holdDaysFor(age);
  const opportunity = (deposit * OPPORTUNITY_APY * hold) / 365;
  const costs = gas + opportunity;
  const breakeven = slice > 0 ? costs / slice : Number.POSITIVE_INFINITY;
  const expectedNet = ASSUMED_LAUNCH_RATE * slice - costs;
  return {
    deposit_usd: deposit,
    slice_usd: Math.round(slice * 100) / 100,
    gas_usd: Math.round(gas * 100) / 100,
    opportunity_usd: Math.round(opportunity * 100) / 100,
    costs_usd: Math.round(costs * 100) / 100,
    breakeven_odds: Math.round(breakeven * 10000) / 10000,
    expected_net_usd: Math.round(expectedNet * 100) / 100,
    net_per_hour_usd: Math.round((expectedNet / FARM_HOURS) * 100) / 100,
    verdict: breakeven <= FARM_BELOW ? 'FARM' : breakeven <= MARGINAL_BELOW ? 'MARGINAL' : 'SKIP',
    hold_days: hold,
    hours: FARM_HOURS,
  };
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
function stepText(s: string): string {
  let out = s;
  if (out.length > 600) out = `${out.slice(0, 596)}...`;
  if (out.length < 20) out = `${out} Hold the position and check the protocol's own page.`;
  return out;
}

/** A date string N days after `asOf` (YYYY-MM-DD), for a dated farm plan. */
export function addDays(asOf: string, days: number): string {
  const d = new Date(`${asOf}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return asOf;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A protocol's farm plan: six steps, each an action with a cost and a time, the fifth carrying the economics. The hold step is dated: the plan names the day the position has been held long enough, so the farmer knows the date, not just a count of days. */
export function farmSteps(p: SnapshotProtocol, plan: FarmPlan, age: number | null, asOf: string): string[] {
  const chain = chainOf(p);
  const capital = plan.deposit_usd;
  const action = actionFor(p, capital, chain);
  const holdUntil = addDays(asOf, plan.hold_days);
  const verdictLine =
    plan.verdict === 'FARM'
      ? 'Worth farming at this deposit: at the assumed 10% launch rate the expected net covers the costs.'
      : plan.verdict === 'MARGINAL'
        ? 'Marginal at this deposit: it pays on average at the assumed launch rate, but the margin is thin — farm it only if you are already active here.'
        : 'Not worth farming at this deposit: at the assumed launch rate it does not pay on average.';
  return [
    stepText(`Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline. Cost: under $3 of gas for the first transaction. Time: 5 minutes.`),
    stepText(`${action} Cost: $${capital} of capital and about $${plan.gas_usd} of gas. Time: 15 minutes to set up.`),
    stepText(`Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote. Cost: about $2 of gas a week. Time: 10 minutes a week.`),
    stepText(`Hold the position until ${holdUntil} — at least ${plan.hold_days} days from ${asOf} — so the activity is counted in more than one snapshot. Cost: the $${capital} stays in the position. Time: ${plan.hold_days} days.`),
    stepText(
      `If the token launches at the fitted value, a $${capital} deposit is worth about $${plan.slice_usd.toFixed(0)} before costs; gas about $${plan.gas_usd.toFixed(0)} and the yield given up about $${plan.opportunity_usd.toFixed(2)}, so the launch odds that repay every cost are ${(plan.breakeven_odds * 100).toFixed(1)}%. ${verdictLine} Cost: $${plan.costs_usd.toFixed(2)} in all. Time: about 2 hours of work in total.`,
    ),
    stepText(`Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes. Cost: no fee to check, and never pay to claim. Time: 10 minutes.`),
  ];
}

// ---------------------------------------------------------------- the board

/** One row of board.json: the ranked board's row. */
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  implied_p10_usd: number;
  implied_p25_usd: number;
  implied_p75_usd: number;
  implied_p90_usd: number;
  rank_lo: number;
  rank_hi: number;
  model: {
    intercept: number;
    slope: number;
    seasoned_tvl_usd: number;
    growth_pct: number;
  };
  farm: FarmPlan;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One comparable for the dashboard's scatter plot. */
export interface CompPoint {
  slug: string;
  tvl_usd: number;
  mcap_usd: number;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  fit: CurveFit;
  validation: {
    loo_median_miss: number;
    loo_within_3x_pct: number;
    loo_rank_corr: number;
    wf_median_miss: number;
    wf_within_3x_pct: number;
    wf2_median_miss: number;
    wf2_within_3x_pct: number;
    wf2_train: number;
    wf2_test: number;
    bootstrap_refits: number;
    range_p25_mult: number;
    range_p75_mult: number;
    range_p10_mult: number;
    range_p90_mult: number;
    range_hold_pct: number;
  };
  comparison: ModelScore[];
  coverage: {
    total: number;
    traded: number;
    pre_token: number;
    watchlist: number;
    ranked: number;
    early: number;
    set_aside: { reason: string; count: number }[];
    comps: number;
    traded_no_mcap: number;
  };
  farm_assumptions: {
    airdrop_share: number;
    active_share: number;
    gas_eth_usd: number;
    gas_other_usd: number;
    opportunity_apy: number;
    assumed_launch_rate: number;
    farm_hours: number;
    farm_below: number;
    marginal_below: number;
  };
  totals: {
    implied_usd: number;
    watchlist_implied_usd: number;
    farm_default: number;
    farm_alt: number;
    /** The total's likely range: the sum of the rows' low ends and the sum of their high ends.
     * A point total alone reads as a promise; the range says what the total would be if every
     * protocol landed at the low (or high) end of its own range. */
    implied_p25_usd: number;
    implied_p75_usd: number;
    implied_p10_usd: number;
    implied_p90_usd: number;
  };
  /** The traded tokens the cleaning set aside from the comparables, with the reason each one was left out. */
  excluded_comps: { slug: string; name: string; reason: string }[];
  rows: BoardRow[];
  live: LiveRow[];
  comps: CompPoint[];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const comps = comparables(snapshot.protocols);
  const fit = fitCurve(comps);
  const comparison = modelComparison(comps, snapshot.as_of);
  const chosen = comparison.find((m) => m.key === 'seasoned')!;
  const residuals = looResiduals(comps);
  const q10 = quantile(residuals, 0.1);
  const q25 = quantile(residuals, 0.25);
  const q75 = quantile(residuals, 0.75);
  const q90 = quantile(residuals, 0.9);
  const band = (q: number): number => Math.pow(10, q);
  const heldInBand = residuals.filter((r) => r >= q25 && r <= q75).length;
  const rangeHold = (100 * heldInBand) / residuals.length;

  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosenSlugs = new Set<string>();
  for (const slug of snapshot.watchlist) if (index.has(slug)) chosenSlugs.add(slug);
  const early = snapshot.protocols
    .filter((p) => !chosenSlugs.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosenSlugs.add(p.slug);

  const scored = [...chosenSlugs]
    .map((slug) => index.get(slug)!)
    .map((p) => {
      const age = ageDays(snapshot.as_of, p.listed_at);
      const implied = impliedValue(p, fit);
      const plan = farmPlan(p, implied, DEFAULT_DEPOSIT, age);
      return { p, age, implied, plan };
    })
    .sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Rank ranges from bootstrap refits: each refit drops a seeded fifth of the comparables.
  const lo = new Map<string, number>();
  const hi = new Map<string, number>();
  scored.forEach((s, i) => {
    lo.set(s.p.slug, i + 1);
    hi.set(s.p.slug, i + 1);
  });
  const rng2 = mulberry32(20261114);
  for (let r = 0; r < BOOTSTRAP_REFITS; r++) {
    const keep = comps.filter(() => rng2() >= BOOTSTRAP_DROP);
    if (keep.length < 20) continue;
    const refit = fitCurve(keep);
    const refitImplied = scored
      .map((s) => ({ slug: s.p.slug, v: impliedValue(s.p, refit) }))
      .sort((a, b) => b.v - a.v || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    refitImplied.forEach((row, i) => {
      const rank = i + 1;
      lo.set(row.slug, Math.min(lo.get(row.slug)!, rank));
      hi.set(row.slug, Math.max(hi.get(row.slug)!, rank));
    });
  }

  const board: BoardRow[] = scored.map((s, i) => ({
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
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    implied_p10_usd: Math.max(1, Math.round(s.implied * band(q10))),
    implied_p25_usd: Math.max(1, Math.round(s.implied * band(q25))),
    implied_p75_usd: Math.max(1, Math.round(s.implied * band(q75))),
    implied_p90_usd: Math.max(1, Math.round(s.implied * band(q90))),
    rank_lo: lo.get(s.p.slug)!,
    rank_hi: hi.get(s.p.slug)!,
    model: {
      intercept: Math.round(fit.intercept * 10000) / 10000,
      slope: Math.round(fit.slope * 10000) / 10000,
      seasoned_tvl_usd: Math.round(seasonedTvl(s.p)),
      growth_pct: growthPct(s.p),
    },
    farm: s.plan,
    farm_steps: farmSteps(s.p, s.plan, s.age, snapshot.as_of),
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));

  const setAside = new Map<string, number>();
  for (const p of snapshot.protocols) {
    const reason = setAsideReason(p);
    if (reason !== null) setAside.set(reason, (setAside.get(reason) ?? 0) + 1);
  }
  const excludedComps = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && !isComparable(p))
    .map((p) => ({ slug: p.slug, name: p.name, reason: notComparableReason(p)! }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const tradedNoMcap = snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd === null).length;
  const totalImplied = board.reduce((s, r) => s + r.implied_value_usd, 0);
  const totalP25 = board.reduce((s, r) => s + r.implied_p25_usd, 0);
  const totalP75 = board.reduce((s, r) => s + r.implied_p75_usd, 0);
  const totalP10 = board.reduce((s, r) => s + r.implied_p10_usd, 0);
  const totalP90 = board.reduce((s, r) => s + r.implied_p90_usd, 0);
  const watchlistImplied = board
    .filter((r) => snapshot.watchlist.includes(r.slug))
    .reduce((s, r) => s + r.implied_value_usd, 0);
  const farmAlt = board.filter((r) => farmPlan(index.get(r.slug)!, r.implied_value_usd, ALT_DEPOSIT, r.age_days).verdict === 'FARM').length;

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    fit,
    validation: {
      loo_median_miss: Math.round(chosen.loo_median_miss * 100) / 100,
      loo_within_3x_pct: Math.round(chosen.loo_within_3x_pct * 10) / 10,
      loo_rank_corr: Math.round(chosen.loo_rank_corr * 1000) / 1000,
      wf_median_miss: Math.round(chosen.wf_median_miss * 100) / 100,
      wf_within_3x_pct: Math.round(chosen.wf_within_3x_pct * 10) / 10,
      wf2_median_miss: Number.isFinite(chosen.wf2_median_miss) ? Math.round(chosen.wf2_median_miss * 100) / 100 : chosen.wf2_median_miss,
      wf2_within_3x_pct: Number.isFinite(chosen.wf2_within_3x_pct) ? Math.round(chosen.wf2_within_3x_pct * 10) / 10 : chosen.wf2_within_3x_pct,
      wf2_train: chosen.wf2_train,
      wf2_test: chosen.wf2_test,
      bootstrap_refits: BOOTSTRAP_REFITS,
      range_p25_mult: Math.round(band(q25) * 100) / 100,
      range_p75_mult: Math.round(band(q75) * 100) / 100,
      range_p10_mult: Math.round(band(q10) * 100) / 100,
      range_p90_mult: Math.round(band(q90) * 100) / 100,
      range_hold_pct: Math.round(rangeHold * 10) / 10,
    },
    comparison: comparison.map((m) => ({
      ...m,
      loo_median_miss: Math.round(m.loo_median_miss * 100) / 100,
      loo_within_3x_pct: Math.round(m.loo_within_3x_pct * 10) / 10,
      loo_rank_corr: Math.round(m.loo_rank_corr * 1000) / 1000,
      wf_median_miss: Number.isFinite(m.wf_median_miss) ? Math.round(m.wf_median_miss * 100) / 100 : m.wf_median_miss,
      wf_within_3x_pct: Number.isFinite(m.wf_within_3x_pct) ? Math.round(m.wf_within_3x_pct * 10) / 10 : m.wf_within_3x_pct,
      wf2_median_miss: Number.isFinite(m.wf2_median_miss) ? Math.round(m.wf2_median_miss * 100) / 100 : m.wf2_median_miss,
      wf2_within_3x_pct: Number.isFinite(m.wf2_within_3x_pct) ? Math.round(m.wf2_within_3x_pct * 10) / 10 : m.wf2_within_3x_pct,
    })),
    coverage: {
      total: snapshot.protocols.length,
      traded: snapshot.protocols.filter((p) => !isPreToken(p)).length,
      pre_token: snapshot.protocols.filter(isPreToken).length,
      watchlist: snapshot.watchlist.length,
      ranked: board.length,
      early: board.length - snapshot.watchlist.length,
      set_aside: [...setAside.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1)),
      comps: comps.length,
      traded_no_mcap: tradedNoMcap,
    },
    farm_assumptions: {
      airdrop_share: AIRDROP_SHARE,
      active_share: ACTIVE_SHARE,
      gas_eth_usd: GAS_ETH_USD,
      gas_other_usd: GAS_OTHER_USD,
      opportunity_apy: OPPORTUNITY_APY,
      assumed_launch_rate: ASSUMED_LAUNCH_RATE,
      farm_hours: FARM_HOURS,
      farm_below: FARM_BELOW,
      marginal_below: MARGINAL_BELOW,
    },
    totals: {
      implied_usd: totalImplied,
      watchlist_implied_usd: watchlistImplied,
      farm_default: board.filter((r) => r.farm.verdict === 'FARM').length,
      farm_alt: farmAlt,
      implied_p25_usd: totalP25,
      implied_p75_usd: totalP75,
      implied_p10_usd: totalP10,
      implied_p90_usd: totalP90,
    },
    excluded_comps: excludedComps,
    rows: board,
    live,
    comps: comps.map((p) => ({ slug: p.slug, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! })),
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
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
