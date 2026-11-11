import type { Address, Log } from "viem";
import type { Market, RawTrade } from "../types.ts";
import type { Rpc } from "../rpc.ts";
import { addrFromTopic, base, lc, readAddr, words, ZERO, type VenueAdapter } from "./common.ts";

export const V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822" as const;
const getPairAbi = [{ type: "function", name: "getPair", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "address" }] }] as const;

export async function v2MarketFromPool(rpc: Rpc, pool: Address, token: Address, venue = "uniswap-v2"): Promise<Market | null> {
  try {
    await rpc.client.readContract({
      address: pool,
      abi: [{ type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ type: "uint112" }, { type: "uint112" }, { type: "uint32" }] }],
      functionName: "getReserves",
    });
  } catch {
    return null; // not a V2 pair
  }
  const t0 = await readAddr(rpc, pool, "token0");
  const t1 = await readAddr(rpc, pool, "token1");
  if (!t0 || !t1) return null;
  if (lc(t0) === lc(token)) return { venue, address: pool, token, quote: t1, tokenIndex: 0 };
  if (lc(t1) === lc(token)) return { venue, address: pool, token, quote: t0, tokenIndex: 1 };
  return null;
}

/// Pure decoder for a Uniswap V2 Swap log.
export function decodeV2(l: Log, m: Market): RawTrade | null {
  if (l.topics[0] !== V2_SWAP) return null;
  const [a0In, a1In, a0Out, a1Out] = words(l.data);
  const t = m.tokenIndex === 0;
  const tokOut = t ? a0Out : a1Out, tokIn = t ? a0In : a1In;
  const qIn = t ? a1In : a0In, qOut = t ? a1Out : a0Out;
  const side = tokOut > tokIn ? "buy" : "sell";
  return {
    venue: m.venue, market: m.address, token: m.token, side,
    tokenAmount: side === "buy" ? tokOut - tokIn : tokIn - tokOut,
    quoteAmount: side === "buy" ? qIn - qOut : qOut - qIn,
    eventSender: addrFromTopic(l.topics[1]!), eventRecipient: addrFromTopic(l.topics[2]!),
    ...base(l),
  };
}

export const uniswapV2: VenueAdapter = {
  name: "uniswap-v2",
  async discover(rpc, token, o) {
    const out: Market[] = [];
    for (const p of o.pools ?? []) {
      const m = await v2MarketFromPool(rpc, p, token);
      if (m) out.push(m);
    }
    for (const f of o.v2Factories ?? []) {
      for (const q of o.quotes.filter((q) => q !== ZERO)) {
        try {
          const pair = (await rpc.client.readContract({ address: f, abi: getPairAbi, functionName: "getPair", args: [token, q] })) as Address;
          if (pair && pair !== ZERO) {
            const m = await v2MarketFromPool(rpc, pair, token);
            if (m) out.push(m);
          }
        } catch {
          /* factory not on this chain */
        }
      }
    }
    return out;
  },
  async fetch(rpc, markets, fromBlock, toBlock) {
    if (!markets.length) return [];
    const byAddr = new Map(markets.map((m) => [lc(m.address), m]));
    const logs = await rpc.getLogs({ address: markets.map((m) => m.address), topics: [V2_SWAP], fromBlock, toBlock });
    return logs.map((l) => decodeV2(l, byAddr.get(lc(l.address))!)).filter((x): x is RawTrade => !!x);
  },
};
