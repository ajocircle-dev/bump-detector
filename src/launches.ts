// Launch discovery for the launchpad command. Launchpad agnostic: a "launch" is any new
// market for a token, read from the factory that created it.
//   pons : Pons TokenLaunched(token, curve, creator)
//   v2   : Uniswap V2 style PairCreated(token0, token1, pair, n)   (any V2 fork)
//   v3   : Uniswap V3 style PoolCreated(token0, token1, fee, tickSpacing, pool)
// For v2 / v3 the launched token is the side that is not a quote asset (WETH, stables).
import { toEventSelector, type Address, type Hex, type Log } from "viem";
import type { Rpc } from "./rpc.ts";
import { addrFromTopic, words, lc } from "./adapters/common.ts";
import { ponsLaunches } from "./adapters/pons.ts";

export type LaunchKind = "pons" | "v2" | "v3";
export const PAIR_CREATED = toEventSelector("PairCreated(address,address,address,uint256)");
export const POOL_CREATED = toEventSelector("PoolCreated(address,address,uint24,int24,address)");

export interface LaunchInfo {
  kind: LaunchKind;
  token: Address;
  market: Address;
  quote: Address | null;
  block: number;
  tx: Hex;
  venue: string; // adapter name for the market
}

const wordAddr = (w: bigint) => `0x${w.toString(16).padStart(40, "0")}` as Address;

/// Pure decoder for PairCreated / PoolCreated logs.
export function decodeCreated(l: Log, quotes: Address[]): LaunchInfo | null {
  const t0 = l.topics[0];
  if ((t0 !== PAIR_CREATED && t0 !== POOL_CREATED) || l.topics.length < 3) return null;
  const a = addrFromTopic(l.topics[1]!), b = addrFromTopic(l.topics[2]!);
  const q = new Set(quotes.map(lc));
  let token: Address, quote: Address;
  if (q.has(lc(b)) && !q.has(lc(a))) [token, quote] = [a, b];
  else if (q.has(lc(a)) && !q.has(lc(b))) [token, quote] = [b, a];
  else return null; // neither or both sides are quote assets: not a token launch
  const w = words(l.data);
  const v2 = t0 === PAIR_CREATED;
  const market = wordAddr(v2 ? w[0] : w[1]);
  return { kind: v2 ? "v2" : "v3", token, quote, market, block: Number(l.blockNumber), tx: l.transactionHash as Hex, venue: v2 ? "uniswap-v2" : "uniswap-v3" };
}

export async function findLaunches(rpc: Rpc, kind: LaunchKind, factories: Address[], quotes: Address[], fromBlock: number, toBlock: number): Promise<LaunchInfo[]> {
  if (kind === "pons") {
    const ls = await ponsLaunches(rpc as never, factories, fromBlock, toBlock);
    return ls.map((l) => ({ kind, token: l.token, market: l.curve, quote: null, block: l.block, tx: l.tx, venue: "pons" }));
  }
  if (!quotes.length) throw new Error("--quote (or a preset WETH) is required to tell the launched token from the quote asset");
  const logs = await rpc.getLogs({ address: factories, topics: [kind === "v2" ? PAIR_CREATED : POOL_CREATED], fromBlock, toBlock });
  return logs.map((l) => decodeCreated(l, quotes)).filter((x): x is LaunchInfo => !!x);
}
