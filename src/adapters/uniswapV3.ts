import type { Address, Log } from "viem";
import type { Market, RawTrade } from "../types.ts";
import { abs, addrFromTopic, base, lc, readAddr, signed, words, ZERO, type VenueAdapter } from "./common.ts";

export const V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67" as const;
const FEES = [100, 500, 3000, 10000];
const getPoolAbi = [{ type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] }] as const;

/// Pure decoder. V3 amounts are from the pool's view: positive = into the pool.
export function decodeV3(l: Log, m: Market): RawTrade | null {
  if (l.topics[0] !== V3_SWAP) return null;
  const w = words(l.data);
  const a0 = signed(w[0]), a1 = signed(w[1]);
  const tok = m.tokenIndex === 0 ? a0 : a1;
  const q = m.tokenIndex === 0 ? a1 : a0;
  const side = tok < 0n ? "buy" : "sell";
  return {
    venue: m.venue, market: m.address, token: m.token, side,
    tokenAmount: abs(tok), quoteAmount: abs(q),
    eventSender: addrFromTopic(l.topics[1]!), eventRecipient: addrFromTopic(l.topics[2]!),
    ...base(l),
  };
}

export const uniswapV3: VenueAdapter = {
  name: "uniswap-v3",
  async discover(rpc, token, o) {
    const out: Market[] = [];
    const add = async (pool: Address, fee?: number) => {
      const t0 = await readAddr(rpc, pool, "token0");
      const t1 = await readAddr(rpc, pool, "token1");
      if (!t0 || !t1) return;
      if (lc(t0) === lc(token)) out.push({ venue: "uniswap-v3", address: pool, token, quote: t1, tokenIndex: 0, fee });
      else if (lc(t1) === lc(token)) out.push({ venue: "uniswap-v3", address: pool, token, quote: t0, tokenIndex: 1, fee });
    };
    for (const p of o.pools ?? []) {
      // only accept explicit pools that look like V3 (have fee())
      try {
        await rpc.client.readContract({ address: p, abi: [{ type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] }], functionName: "fee" });
        await add(p);
      } catch {
        /* not v3 */
      }
    }
    for (const f of o.v3Factories ?? [])
      for (const q of o.quotes.filter((q) => q !== ZERO))
        for (const fee of FEES) {
          try {
            const pool = (await rpc.client.readContract({ address: f, abi: getPoolAbi, functionName: "getPool", args: [token, q, fee] })) as Address;
            if (pool && pool !== ZERO) await add(pool, fee);
          } catch {
            /* skip */
          }
        }
    return out;
  },
  async fetch(rpc, markets, fromBlock, toBlock) {
    if (!markets.length) return [];
    const byAddr = new Map(markets.map((m) => [lc(m.address), m]));
    const logs = await rpc.getLogs({ address: markets.map((m) => m.address), topics: [V3_SWAP], fromBlock, toBlock });
    return logs.map((l) => decodeV3(l, byAddr.get(lc(l.address))!)).filter((x): x is RawTrade => !!x);
  },
};
