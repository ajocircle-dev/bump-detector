import type { Hex, Log } from "viem";
import type { Market, RawTrade } from "../types.ts";
import { abs, addrFromTopic, base, lc, signed, topicAddr, words, type VenueAdapter } from "./common.ts";

export const V4_SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f" as const;
export const V4_INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" as const;

/// Pure decoder. V4 PoolManager Swap amounts are deltas for the swapper:
/// positive = the swapper received that currency.
export function decodeV4(l: Log, m: Market): RawTrade | null {
  if (l.topics[0] !== V4_SWAP) return null;
  if (m.poolId && lc(l.topics[1]!) !== lc(m.poolId)) return null;
  const w = words(l.data);
  const a0 = signed(w[0], 256), a1 = signed(w[1], 256);
  const tok = m.tokenIndex === 0 ? a0 : a1;
  const q = m.tokenIndex === 0 ? a1 : a0;
  const side = tok > 0n ? "buy" : "sell";
  return {
    venue: "uniswap-v4", market: m.address, token: m.token, side,
    tokenAmount: abs(tok), quoteAmount: abs(q),
    eventSender: addrFromTopic(l.topics[2]!),
    ...base(l),
  };
}

export const uniswapV4: VenueAdapter = {
  name: "uniswap-v4",
  async discover(rpc, token, o) {
    if (!o.v4PoolManager) return [];
    const pm = o.v4PoolManager;
    const out: Market[] = [];
    const seen = new Set<string>();
    for (const [pos, idx] of [[2, 0], [3, 1]] as const) {
      const topics: (Hex | null)[] = [V4_INITIALIZE, null, null, null];
      topics[pos] = topicAddr(token);
      let logs: Log[] = [];
      try {
        logs = await rpc.getLogs({ address: pm, topics, fromBlock: 0, toBlock: o.toBlock });
      } catch {
        logs = [];
      }
      for (const l of logs) {
        const id = l.topics[1] as Hex;
        if (o.v4PoolIds && !o.v4PoolIds.map(lc).includes(lc(id))) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        const other = addrFromTopic(l.topics[idx === 0 ? 3 : 2]!);
        out.push({ venue: "uniswap-v4", address: pm, token, quote: other, tokenIndex: idx, poolId: id });
      }
    }
    return out;
  },
  async fetch(rpc, markets, fromBlock, toBlock) {
    if (!markets.length) return [];
    const pm = markets[0].address;
    const byId = new Map(markets.map((m) => [lc(m.poolId!), m]));
    const logs = await rpc.getLogs({ address: pm, topics: [V4_SWAP, markets.map((m) => m.poolId!)], fromBlock, toBlock });
    return logs.map((l) => decodeV4(l, byId.get(lc(l.topics[1]!))!)).filter((x): x is RawTrade => !!x);
  },
};
