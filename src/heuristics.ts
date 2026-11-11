// Pure scoring logic. No network access here, so it is unit tested with fixtures.
import type { Address, Hex } from "viem";
import type { ClusterReport, Trade, TokenReport, Verdict, WalletInfo, Market } from "./types.ts";

export interface Params {
  burstGapSec: number; // trades closer than this belong to the same burst
  minClusterTrades: number; // ignore clusters with fewer trades
  equalFundingTol: number; // relative spread allowed for "equal" funding
  coTradeMinBursts: number; // co-trading edge needs this many shared bursts
  maxBurstForEdges: number; // ignore busy bursts (organic flow) when building co-trading edges
  flagThreshold: number; // cluster score at or above this is flagged
  suspiciousThreshold: number;
}

export const DEFAULT_PARAMS: Params = {
  burstGapSec: 3,
  minClusterTrades: 6,
  equalFundingTol: 0.02,
  coTradeMinBursts: 3,
  maxBurstForEdges: 12,
  flagThreshold: 60,
  suspiciousThreshold: 40,
};

export const MAX_APPROVE_MIN = 1n << 255n;
const PRESET_GAPS = [10, 20, 30, 60];
const lc = (a: string) => a.toLowerCase();
const short = (a: string) => `${a.slice(0, 6)}..${a.slice(-4)}`;

export function sortTrades(t: Trade[]): Trade[] {
  return [...t].sort((a, b) => a.block - b.block || a.txIndex - b.txIndex || a.logIndex - b.logIndex);
}

export function bursts(trades: Trade[], gapSec: number): Trade[][] {
  const s = sortTrades(trades);
  const out: Trade[][] = [];
  for (const t of s) {
    const cur = out[out.length - 1];
    if (cur && t.timestamp - cur[cur.length - 1].timestamp <= gapSec) cur.push(t);
    else out.push([t]);
  }
  return out;
}

function stats(xs: number[]) {
  const n = xs.length;
  if (!n) return { mean: 0, sd: 0, cv: Infinity, min: 0, max: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean, sd, cv: mean > 0 ? sd / mean : Infinity, min: Math.min(...xs), max: Math.max(...xs) };
}

class UF {
  p = new Map<string, string>();
  find(x: string): string {
    if (!this.p.has(x)) this.p.set(x, x);
    const y = this.p.get(x)!;
    if (y === x) return x;
    const r = this.find(y);
    this.p.set(x, r);
    return r;
  }
  union(a: string, b: string) {
    this.p.set(this.find(a), this.find(b));
  }
}

/// Group wallets into candidate clusters: first by common funder, then by repeated
/// co-trading in the same short bursts.
export function candidateClusters(trades: Trade[], wallets: Map<string, WalletInfo>, p: Params) {
  const active = new Map<string, number>();
  for (const t of trades) active.set(lc(t.trader), (active.get(lc(t.trader)) ?? 0) + 1);
  const out: { basis: "common-funder" | "co-trading"; wallets: string[]; funder: string | null }[] = [];
  const used = new Set<string>();
  const byFunder = new Map<string, string[]>();
  for (const w of active.keys()) {
    const f = wallets.get(w)?.funding?.funder;
    if (!f) continue;
    const k = lc(f);
    if (!byFunder.has(k)) byFunder.set(k, []);
    byFunder.get(k)!.push(w);
  }
  for (const [f, ws] of byFunder) {
    if (ws.length < 2) continue;
    out.push({ basis: "common-funder", wallets: ws, funder: f });
    ws.forEach((w) => used.add(w));
  }
  // co-trading graph on the remaining wallets
  const bs = bursts(trades, p.burstGapSec).filter((b) => b.length <= p.maxBurstForEdges);
  const per = new Map<string, number>();
  const pair = new Map<string, number>();
  for (const b of bs) {
    const ws = [...new Set(b.map((t) => lc(t.trader)))].filter((w) => !used.has(w));
    for (const w of ws) per.set(w, (per.get(w) ?? 0) + 1);
    for (let i = 0; i < ws.length; i++)
      for (let j = i + 1; j < ws.length; j++) {
        const k = ws[i] < ws[j] ? `${ws[i]}|${ws[j]}` : `${ws[j]}|${ws[i]}`;
        pair.set(k, (pair.get(k) ?? 0) + 1);
      }
  }
  const uf = new UF();
  for (const [k, n] of pair) {
    const [a, b] = k.split("|");
    if (n >= p.coTradeMinBursts && n >= 0.35 * Math.max(per.get(a)!, per.get(b)!)) uf.union(a, b);
  }
  const comps = new Map<string, string[]>();
  for (const w of per.keys()) {
    if (!uf.p.has(w)) continue;
    const r = uf.find(w);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(w);
  }
  for (const ws of comps.values()) if (ws.length >= 2) out.push({ basis: "co-trading", wallets: ws, funder: null });
  return out;
}

export function scoreCluster(
  id: string,
  basis: "common-funder" | "co-trading",
  walletList: string[],
  funderHint: string | null,
  allTrades: Trade[],
  wallets: Map<string, WalletInfo>,
  p: Params,
): ClusterReport | null {
  const set = new Set(walletList.map(lc));
  const ct = sortTrades(allTrades.filter((t) => set.has(lc(t.trader))));
  if (ct.length < p.minClusterTrades) return null;
  const reasons: string[] = [];
  let score = 0;
  const f: Record<string, unknown> = {};

  // ---- bursts / cycle shape ----
  const bs = bursts(ct, p.burstGapSec);
  let core = bs;
  const last = bs[bs.length - 1];
  const unwind = bs.length >= 3 && last.every((t) => t.side === "sell");
  if (unwind) core = bs.slice(0, -1);
  const shape = (b: Trade[]) => `${b.filter((t) => t.side === "buy").length}B/${b.filter((t) => t.side === "sell").length}S`;
  const counts = new Map<string, number>();
  for (const b of core) counts.set(shape(b), (counts.get(shape(b)) ?? 0) + 1);
  const [dom, domN] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const share = core.length ? domN / core.length : 0;
  f.bursts = bs.length;
  f.dominantShape = dom;
  f.dominantShare = Number(share.toFixed(3));
  f.unwindBurst = unwind;
  const [db, ds] = dom ? dom.split("/").map((x) => parseInt(x)) : [0, 0];
  if (core.length >= 4 && share >= 0.6 && db >= 1 && ds >= 1) {
    score += 15;
    reasons.push(`repeating ${dom} cycle in ${domN} of ${core.length} bursts`);
  } else if (core.length >= 4 && share >= 0.4 && db >= 1 && ds >= 1) {
    score += 8;
    reasons.push(`partly repeating ${dom} cycle (${domN} of ${core.length} bursts)`);
  } else if (core.length >= 4 && share >= 0.6 && db >= 1) {
    score += 5;
    reasons.push(`repeating buy-only bursts (${dom})`);
  }

  // ---- rotating seller ----
  const sellers = core.flatMap((b) => b.filter((t) => t.side === "sell").map((t) => lc(t.trader)));
  if (sellers.length >= 3) {
    let distinct = 0;
    for (let i = 1; i < sellers.length; i++) if (sellers[i] !== sellers[i - 1]) distinct++;
    const ratio = distinct / (sellers.length - 1);
    const coverage = new Set(sellers).size / set.size;
    f.sellerRotation = Number(ratio.toFixed(3));
    f.sellerCoverage = Number(coverage.toFixed(3));
    if (ratio >= 0.8 && coverage >= 0.6) {
      score += 10;
      reasons.push(`seller rotates across ${new Set(sellers).size} of ${set.size} wallets`);
    } else if (ratio >= 0.6) {
      score += 5;
      reasons.push("seller mostly rotates");
    }
  }

  // ---- regular gaps with jitter ----
  const starts = core.map((b) => b[0].timestamp);
  const gaps = starts.slice(1).map((s, i) => s - starts[i]);
  const g = stats(gaps);
  f.gapMeanSec = Number(g.mean.toFixed(2));
  f.gapCv = Number.isFinite(g.cv) ? Number(g.cv.toFixed(3)) : null;
  f.gapMinSec = g.min;
  f.gapMaxSec = g.max;
  const preset = PRESET_GAPS.find((x) => g.mean >= x * 0.8 && g.mean <= x * 1.2) ?? null;
  f.gapPresetMatch = preset;
  if (gaps.length >= 3 && g.cv <= 0.25) {
    score += 10;
    reasons.push(`burst gaps are regular (mean ${g.mean.toFixed(1)}s, cv ${g.cv.toFixed(2)})`);
  } else if (gaps.length >= 3 && g.cv <= 0.4) {
    score += 6;
    reasons.push(`burst gaps fairly regular (mean ${g.mean.toFixed(1)}s, cv ${g.cv.toFixed(2)})`);
  }

  // ---- funding ----
  const infos = [...set].map((w) => wallets.get(w)).filter((x): x is WalletInfo => !!x);
  const funded = infos.filter((w) => w.funding);
  const funders = new Map<string, WalletInfo[]>();
  for (const w of funded) {
    const k = lc(w.funding!.funder);
    if (!funders.has(k)) funders.set(k, []);
    funders.get(k)!.push(w);
  }
  const [topFunder, topList] = [...funders.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [funderHint, []];
  const funder = topList.length >= 2 ? topFunder : funderHint;
  if (topList.length >= 2) {
    const amts = topList.map((w) => Number(w.funding!.amount)).sort((a, b) => a - b);
    const med = amts[Math.floor(amts.length / 2)];
    const spread = med > 0 ? (amts[amts.length - 1] - amts[0]) / med : 1;
    f.commonFunderWallets = topList.length;
    f.fundingSpread = Number(spread.toFixed(4));
    if (spread <= p.equalFundingTol) {
      score += 20;
      reasons.push(`${topList.length} wallets funded with equal amounts by ${short(topFunder!)}`);
    } else {
      score += 10;
      reasons.push(`${topList.length} wallets funded by the same address ${short(topFunder!)}`);
    }
  }

  // ---- fresh wallets ----
  const nonces = infos.filter((w) => w.firstNonce !== null);
  if (nonces.length) {
    const fresh = nonces.filter((w) => w.firstNonce! <= 2).length / nonces.length;
    f.freshShare = Number(fresh.toFixed(3));
    if (fresh >= 0.8) {
      score += 10;
      reasons.push("wallets are brand new (first trade at nonce 0 to 2)");
    } else if (fresh >= 0.5) {
      score += 5;
      reasons.push("most wallets are new");
    }
  }

  // ---- max approve before first sell ----
  const sellerSet = [...new Set(ct.filter((t) => t.side === "sell").map((t) => lc(t.trader)))];
  if (sellerSet.length) {
    let ok = 0;
    for (const w of sellerSet) {
      const first = ct.find((t) => t.side === "sell" && lc(t.trader) === w)!;
      const ap = wallets.get(w)?.approvals ?? [];
      if (ap.some((a) => a.value >= MAX_APPROVE_MIN && (a.block < first.block || (a.block === first.block && a.logIndex < first.logIndex)))) ok++;
    }
    f.maxApproveShare = Number((ok / sellerSet.length).toFixed(3));
    if (ok / sellerSet.length >= 0.8) {
      score += 5;
      reasons.push("every seller max-approved right before its first sell");
    }
  }

  // ---- sell-all ----
  let flat = 0, holders = 0;
  for (const w of set) {
    let b = 0n, s = 0n;
    for (const t of ct) if (lc(t.trader) === w) t.side === "buy" ? (b += t.tokenAmount) : (s += t.tokenAmount);
    if (b === 0n) continue;
    holders++;
    if (b - s <= b / 100n) flat++;
  }
  if (holders) {
    f.flatAtEndShare = Number((flat / holders).toFixed(3));
    if (flat / holders >= 0.8) {
      score += 5;
      reasons.push("wallets end flat (sold everything they bought)");
    }
  }

  // ---- sweep back ----
  const swept = infos.filter((w) => w.sweep);
  if (swept.length) {
    const toFunder = funder ? swept.filter((w) => lc(w.sweep!.to) === lc(funder)).length : 0;
    const dests = new Set(swept.map((w) => lc(w.sweep!.to)));
    f.sweptWallets = swept.length;
    f.sweptToFunder = toFunder;
    if (funder && toFunder / Math.max(1, funded.length || set.size) >= 0.6) {
      score += 10;
      reasons.push(`${toFunder} wallets swept ETH back to the funder`);
    } else if (dests.size === 1 && swept.length >= 2) {
      score += 7;
      reasons.push(`${swept.length} wallets swept ETH to one address ${short([...dests][0])}`);
    }
  }

  // ---- recycled volume ----
  const hasQuote = ct.every((t) => t.quoteAmount !== null);
  let bq = 0n, sq = 0n;
  for (const t of ct) {
    const v = hasQuote ? t.quoteAmount! : t.tokenAmount;
    t.side === "buy" ? (bq += v) : (sq += v);
  }
  const gross = bq + sq;
  const net = bq > sq ? bq - sq : sq - bq;
  const netRatio = gross > 0n ? Number((net * 10000n) / gross) / 10000 : 1;
  f.grossVolume = gross.toString();
  f.netRatio = netRatio;
  f.volumeUnit = hasQuote ? "quote" : "token";
  if (netRatio <= 0.15) {
    score += 10;
    reasons.push(`volume is recycled (net flow ${(netRatio * 100).toFixed(1)}% of gross)`);
  } else if (netRatio <= 0.3) {
    score += 5;
    reasons.push(`volume mostly recycled (net ${(netRatio * 100).toFixed(1)}% of gross)`);
  }

  // ---- dominance ----
  const dom2 = ct.length / allTrades.length;
  f.tapeShare = Number(dom2.toFixed(3));
  if (dom2 >= 0.5) {
    score += 5;
    reasons.push(`cluster is ${(dom2 * 100).toFixed(0)}% of all trades`);
  }

  f.trades = ct.length;
  f.buys = ct.filter((t) => t.side === "buy").length;
  f.sells = ct.filter((t) => t.side === "sell").length;
  const verdict: Verdict = score >= p.flagThreshold ? "likely-bump" : score >= p.suspiciousThreshold ? "suspicious" : "low";
  return {
    id, basis, score, verdict,
    wallets: [...set] as Address[],
    funder: (funder as Address) ?? null,
    reasons, features: f,
    evidence: {
      fundingTxs: funded.map((w) => ({ wallet: w.address, tx: w.funding!.tx, amount: w.funding!.amount.toString(), block: w.funding!.block })),
      sweepTxs: swept.map((w) => ({ wallet: w.address, to: w.sweep!.to, tx: w.sweep!.tx, amount: w.sweep!.amount.toString(), block: w.sweep!.block })),
      approveTxs: infos.flatMap((w) => w.approvals.filter((a) => a.value >= MAX_APPROVE_MIN).map((a) => ({ wallet: w.address, spender: a.spender, tx: a.tx, block: a.block }))),
      tradeTxs: [...new Set(ct.map((t) => t.tx))] as Hex[],
      cyclePattern: bs.slice(0, 60).map((b) => {
        const sl = b.filter((t) => t.side === "sell").map((t) => short(t.trader));
        return `t+${b[0].timestamp - ct[0].timestamp}s ${shape(b)}${sl.length ? ` sellers ${sl.join(",")}` : ""}`;
      }),
    },
  };
}

export function analyze(
  chainId: number, token: Address, markets: Market[], fromBlock: number, toBlock: number,
  trades: Trade[], wallets: Map<string, WalletInfo>, p: Params = DEFAULT_PARAMS,
): TokenReport {
  const cands = candidateClusters(trades, wallets, p);
  const clusters = cands
    .map((c, i) => scoreCluster(`c${i + 1}`, c.basis, c.wallets, c.funder, trades, wallets, p))
    .filter((x): x is ClusterReport => !!x)
    .sort((a, b) => b.score - a.score);
  const flagged = clusters.filter((c) => c.score >= p.flagThreshold);
  const fw = new Set(flagged.flatMap((c) => c.wallets.map(lc)));
  const flaggedTrades = trades.filter((t) => fw.has(lc(t.trader)));
  const ftx = new Set<string>(flaggedTrades.map((t) => t.tx));
  for (const c of flagged) {
    c.evidence.fundingTxs.forEach((x) => ftx.add(x.tx));
    c.evidence.sweepTxs.forEach((x) => ftx.add(x.tx));
    c.evidence.approveTxs.forEach((x) => ftx.add(x.tx));
  }
  const traders = new Set(trades.map((t) => lc(t.trader)));
  const hasQuote = trades.length > 0 && trades.every((t) => t.quoteAmount !== null);
  const score = clusters[0]?.score ?? 0;
  const notes: string[] = [];
  if (!trades.length) notes.push("no trades found in range");
  if ([...wallets.values()].every((w) => !w.funding)) notes.push("no funding transfers found in the scan window; funding rules did not contribute");
  return {
    chainId, token, markets, fromBlock, toBlock, generatedAt: new Date().toISOString(),
    score,
    verdict: score >= p.flagThreshold ? "likely-bump" : score >= p.suspiciousThreshold ? "suspicious" : "low",
    stats: {
      trades: trades.length,
      buys: trades.filter((t) => t.side === "buy").length,
      sells: trades.filter((t) => t.side === "sell").length,
      distinctTraders: traders.size,
      distinctWalletRatio: trades.length ? Number((traders.size / trades.length).toFixed(4)) : 0,
      quoteVolume: hasQuote ? trades.reduce((a, t) => a + t.quoteAmount!, 0n).toString() : null,
      flaggedTradeShare: trades.length ? Number((flaggedTrades.length / trades.length).toFixed(4)) : 0,
    },
    clusters,
    flaggedWallets: [...fw] as Address[],
    flaggedTxs: [...ftx] as Hex[],
    notes,
  };
}
