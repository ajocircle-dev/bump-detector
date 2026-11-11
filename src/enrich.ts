// Per-wallet evidence that is not in the swap events: native ETH funding before the
// first trade, the sweep after the last trade, and token approvals. Works on plain
// (non-archive) RPCs by scanning full blocks in a short time window.
import type { Address, Hex, Transaction } from "viem";
import type { Rpc } from "./rpc.ts";
import { pMap } from "./rpc.ts";
import type { Trade, WalletInfo } from "./types.ts";
import { topicAddr, addrFromTopic, words } from "./adapters/common.ts";
import { sortTrades } from "./heuristics.ts";

export const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925" as const;
const lc = (a: string) => a.toLowerCase();

export interface EnrichOpts {
  windowSec: number; // how far before the first / after the last trade to look
  maxBlocks: number; // hard cap on blocks scanned per direction per wallet group
  maxWallets: number;
  skipFunding?: boolean;
}
export const DEFAULT_ENRICH: EnrichOpts = { windowSec: 45, maxBlocks: 1500, maxWallets: 60 };

/// Walk blocks from `start` in `dir` until block time passes `stopTs` or we hit the cap.
async function scan(rpc: Rpc, start: number, dir: -1 | 1, stopTs: number, maxBlocks: number, head: number, visit: (n: number, txs: Transaction[]) => void) {
  let n = start;
  let done = 0;
  const batch = 25;
  while (done < maxBlocks) {
    const ids: number[] = [];
    for (let i = 0; i < batch && done + i < maxBlocks; i++) {
      const b = n + dir * i;
      if (b < 0 || b > head) break;
      ids.push(b);
    }
    if (!ids.length) return;
    const bs = await pMap(ids, (b) => rpc.block(b), 8);
    let outside = false;
    bs.forEach((b, i) => {
      if (dir === -1 ? b.timestamp < stopTs : b.timestamp > stopTs) outside = true;
      else visit(ids[i], b.transactions);
    });
    done += ids.length;
    n += dir * ids.length;
    if (outside) return;
  }
}

/// Group wallets whose reference trades are close in time so they share one scan.
function timeGroups(ws: string[], ref: Map<string, Trade>, gapSec: number): string[][] {
  const s = [...ws].sort((a, b) => ref.get(a)!.timestamp - ref.get(b)!.timestamp);
  const out: string[][] = [];
  for (const w of s) {
    const g = out[out.length - 1];
    if (g && ref.get(w)!.timestamp - ref.get(g[g.length - 1])!.timestamp <= gapSec) g.push(w);
    else out.push([w]);
  }
  return out;
}

export async function enrich(rpc: Rpc, token: Address, trades: Trade[], candidates: Address[], o: EnrichOpts = DEFAULT_ENRICH, cache = new Map<string, WalletInfo>()): Promise<Map<string, WalletInfo>> {
  const s = sortTrades(trades);
  const ws = candidates.map(lc).slice(0, o.maxWallets);
  const set = new Set(ws);
  const first = new Map<string, Trade>();
  const last = new Map<string, Trade>();
  for (const t of s) {
    const w = lc(t.trader);
    if (!set.has(w)) continue;
    if (!first.has(w)) first.set(w, t);
    last.set(w, t);
  }
  const out = new Map<string, WalletInfo>();
  for (const w of ws) {
    const prev = cache.get(w);
    out.set(w, {
      address: w as Address,
      firstNonce: first.get(w)?.txNonce ?? prev?.firstNonce ?? null,
      funding: prev?.funding ?? null,
      sweep: null,
      approvals: [],
    });
  }
  const head = await rpc.head();

  if (!o.skipFunding) {
    // funding: the latest incoming value transfer before each wallet's first trade
    const need = ws.filter((w) => !out.get(w)!.funding && first.has(w));
    for (const g of timeGroups(need, first, o.windowSec)) {
      const start = Math.max(...g.map((w) => first.get(w)!.block));
      const stopTs = Math.min(...g.map((w) => first.get(w)!.timestamp)) - o.windowSec;
      const gs = new Set(g);
      await scan(rpc, start, -1, stopTs, o.maxBlocks, head, (n, txs) => {
        for (const tx of txs) {
          if (!tx.to || !gs.has(lc(tx.to)) || tx.value === 0n) continue;
          const w = lc(tx.to);
          const ft = first.get(w)!;
          if (n > ft.block || (n === ft.block && Number(tx.transactionIndex) > ft.txIndex)) continue;
          const cur = out.get(w)!;
          if (!cur.funding || n > cur.funding.block) cur.funding = { funder: tx.from, amount: tx.value, tx: tx.hash as Hex, block: n };
        }
      });
    }
    // sweep: first plain value transfer out of each wallet after its last trade
    const done = ws.filter((w) => last.has(w));
    for (const g of timeGroups(done, last, o.windowSec)) {
      const start = Math.min(...g.map((w) => last.get(w)!.block));
      const stopTs = Math.max(...g.map((w) => last.get(w)!.timestamp)) + o.windowSec;
      const gs = new Set(g);
      await scan(rpc, start, 1, stopTs, o.maxBlocks, head, (n, txs) => {
        for (const tx of txs) {
          const w = lc(tx.from);
          if (!gs.has(w) || !tx.to || tx.value === 0n || (tx.input && tx.input !== "0x")) continue;
          const lt = last.get(w)!;
          if (n < lt.block || (n === lt.block && Number(tx.transactionIndex) < lt.txIndex)) continue;
          const cur = out.get(w)!;
          if (!cur.sweep || n < cur.sweep.block) cur.sweep = { to: tx.to, amount: tx.value, tx: tx.hash as Hex, block: n };
        }
      });
    }
  }

  // approvals on the token by these wallets
  if (ws.length && s.length) {
    const from = Math.max(0, Math.min(...ws.filter((w) => first.has(w)).map((w) => out.get(w)!.funding?.block ?? first.get(w)!.block)) - 50);
    const to = Math.max(...ws.filter((w) => last.has(w)).map((w) => last.get(w)!.block));
    for (let i = 0; i < ws.length; i += 40) {
      const chunk = ws.slice(i, i + 40) as Address[];
      const logs = await rpc.getLogs({ address: token, topics: [APPROVAL, chunk.map((a) => topicAddr(a))], fromBlock: from, toBlock: to });
      for (const l of logs) {
        const w = lc(addrFromTopic(l.topics[1]!));
        out.get(w)?.approvals.push({ spender: addrFromTopic(l.topics[2]!), value: words(l.data)[0] ?? 0n, block: Number(l.blockNumber), logIndex: Number(l.logIndex), tx: l.transactionHash as Hex });
      }
    }
  }
  for (const [k, v] of out) cache.set(k, v);
  return out;
}

/// Wallets worth enriching: the most active ones.
export function enrichCandidates(trades: Trade[], max: number): Address[] {
  const c = new Map<string, number>();
  for (const t of trades) c.set(lc(t.trader), (c.get(lc(t.trader)) ?? 0) + 1);
  return [...c.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, max).map(([w]) => w as Address);
}
