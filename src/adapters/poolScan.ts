// Factory-free pool discovery. Any pool that holds the token shows up as a counterparty
// in the token's own Transfer logs, whichever router, aggregator or launchpad sent the
// trade. We rank those counterparties, keep the ones with code, and probe each for the
// Uniswap V2 interface (getReserves, token0, token1), the V3 interface (fee, token0,
// token1) or a Pons-style curve (token()). Recognised pools become normal uniswap-v2,
// uniswap-v3 or pons markets, so their swap events are decoded no matter who called the pool.
import type { Address, Log } from "viem";
import type { Market } from "../types.ts";
import type { Rpc } from "../rpc.ts";
import { TRANSFER } from "./transferFlow.ts";
import { addrFromTopic, lc, readAddr, ZERO } from "./common.ts";
import { v2MarketFromPool } from "./uniswapV2.ts";

/// Pure: addresses seen in the token's Transfer logs, most frequent first.
export function rankCounterparties(logs: Log[], token: Address, exclude: Iterable<string> = []): Address[] {
  const skip = new Set([...exclude].map(lc));
  skip.add(lc(ZERO));
  skip.add(lc(token));
  const n = new Map<string, { a: Address; c: number }>();
  for (const l of logs) {
    if (lc(l.address) !== lc(token) || l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
    for (const t of [l.topics[1]!, l.topics[2]!]) {
      const a = addrFromTopic(t);
      if (skip.has(lc(a))) continue;
      const e = n.get(lc(a)) ?? { a, c: 0 };
      e.c++;
      n.set(lc(a), e);
    }
  }
  return [...n.values()].sort((x, y) => y.c - x.c).map((e) => e.a);
}

export async function v3MarketFromPool(rpc: Rpc, pool: Address, token: Address): Promise<Market | null> {
  let fee: number;
  try {
    fee = Number(
      await rpc.client.readContract({
        address: pool,
        abi: [{ type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }],
        functionName: "fee",
      }),
    );
  } catch {
    return null;
  }
  const t0 = await readAddr(rpc, pool, "token0");
  const t1 = await readAddr(rpc, pool, "token1");
  if (!t0 || !t1) return null;
  if (lc(t0) === lc(token)) return { venue: "uniswap-v3", address: pool, token, quote: t1, tokenIndex: 0, fee };
  if (lc(t1) === lc(token)) return { venue: "uniswap-v3", address: pool, token, quote: t0, tokenIndex: 1, fee };
  return null;
}

/// Bonding curves in the Pons style expose token() and emit CurveBuy / CurveSell.
export async function curveMarket(rpc: Rpc, curve: Address, token: Address): Promise<Market | null> {
  const t = await readAddr(rpc, curve, "token");
  return t && lc(t) === lc(token) ? { venue: "pons", address: curve, token, quote: ZERO } : null;
}

export interface PoolScanOpts {
  known: Set<string>; // market addresses already tracked (lowercase)
  probed: Set<string>; // addresses already probed (lowercase), updated in place
  maxProbe?: number; // max new candidates probed per call
  skip?: Address[]; // e.g. a V4 PoolManager (handled by its own adapter)
}

export async function discoverPoolsFromTransfers(rpc: Rpc, token: Address, fromBlock: number, toBlock: number, o: PoolScanOpts): Promise<Market[]> {
  if (toBlock < fromBlock) return [];
  const logs = await rpc.getLogs({ address: token, topics: [TRANSFER], fromBlock, toBlock });
  const cands = rankCounterparties(logs, token, [...o.known, ...o.probed, ...(o.skip ?? []).map(lc)]).slice(0, o.maxProbe ?? 25);
  const out: Market[] = [];
  for (const a of cands) {
    o.probed.add(lc(a));
    const code = await rpc.client.getCode({ address: a }).catch(() => undefined);
    if (!code || code === "0x") continue; // wallets, not pools
    const m = (await v2MarketFromPool(rpc, a, token)) ?? (await v3MarketFromPool(rpc, a, token)) ?? (await curveMarket(rpc, a, token));
    if (m) out.push(m);
  }
  return out;
}
