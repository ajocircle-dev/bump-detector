import { formatEther } from "viem";
import type { TokenReport } from "./types.ts";

const short = (a: string) => `${a.slice(0, 6)}..${a.slice(-4)}`;

export function toJson(r: TokenReport | TokenReport[]): string {
  return JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function pad(s: string, n: number) {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

export function table(rs: TokenReport[]): string {
  const lines: string[] = [];
  lines.push(`${pad("TOKEN", 14)} ${pad("SCORE", 6)} ${pad("VERDICT", 12)} ${pad("TRADES", 7)} ${pad("WALLETS", 8)} ${pad("FLAGGED%", 9)} TOP CLUSTER`);
  for (const r of rs) {
    const c = r.clusters[0];
    const top = c ? `${c.wallets.length} wallets, ${c.basis}${c.funder ? ` funder ${short(c.funder)}` : ""}, ${c.features.dominantShape ?? "?"}` : "-";
    lines.push(
      `${pad(short(r.token), 14)} ${pad(String(r.score), 6)} ${pad(r.verdict, 12)} ${pad(String(r.stats.trades), 7)} ${pad(String(r.stats.distinctTraders), 8)} ${pad((r.stats.flaggedTradeShare * 100).toFixed(1), 9)} ${top}`,
    );
  }
  return lines.join("\n");
}

export function detail(r: TokenReport): string {
  const L: string[] = [];
  L.push(`token ${r.token} on chain ${r.chainId}, blocks ${r.fromBlock} to ${r.toBlock}`);
  L.push(`markets: ${r.markets.map((m) => `${m.venue}@${short(m.address)}${m.poolId ? `#${m.poolId.slice(0, 10)}` : ""}${m.nativeQuote ? " (ETH)" : ""}${m.discoveredBy ? ` [${m.discoveredBy}]` : ""}`).join(", ") || "none"}`);
  const vol = r.stats.nativeVolumeWei ? `, ETH volume ${formatEther(BigInt(r.stats.nativeVolumeWei))}` : r.stats.quoteVolume ? `, quote volume ${formatEther(BigInt(r.stats.quoteVolume))}` : "";
  L.push(`trades ${r.stats.trades} (${r.stats.buys} buys, ${r.stats.sells} sells), distinct wallets ${r.stats.distinctTraders}, ratio ${r.stats.distinctWalletRatio}${vol}`);
  const eps = Object.entries(r.stats.entryPoints ?? {}).sort((a, b) => b[1] - a[1]);
  if (eps.length) L.push(`entry points (tx.to): ${eps.map(([k, n]) => `${k.startsWith("0x") ? short(k) : k} ${n}`).join(", ")}`);
  L.push(`score ${r.score} -> ${r.verdict}`);
  for (const c of r.clusters) {
    L.push(`  [${c.id}] score ${c.score} ${c.verdict} basis ${c.basis} wallets ${c.wallets.length}${c.funder ? ` funder ${c.funder}` : ""}`);
    for (const why of c.reasons) L.push(`      - ${why}`);
    for (const w of c.wallets) L.push(`      wallet ${w}`);
    for (const ft of c.evidence.fundingTxs) L.push(`      funding ${short(ft.wallet)} ${formatEther(BigInt(ft.amount))} tx ${ft.tx}`);
    for (const s of c.evidence.sweepTxs) L.push(`      sweep ${short(s.wallet)} -> ${short(s.to)} ${formatEther(BigInt(s.amount))} tx ${s.tx}`);
    if (c.evidence.cyclePattern.length) L.push(`      cycles: ${c.evidence.cyclePattern.slice(0, 8).join(" | ")}${c.evidence.cyclePattern.length > 8 ? " | ..." : ""}`);
  }
  for (const n of r.notes) L.push(`note: ${n}`);
  return L.join("\n");
}
