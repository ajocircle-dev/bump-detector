// Generic fallback for any venue: treat ERC-20 Transfer events between a known
// market address (pool, curve, OTC contract) and anyone else as trades.
// Out of the market = buy, into the market = sell. Quote side is unknown.
import type { Log } from "viem";
import type { Market, RawTrade } from "../types.ts";
import { addrFromTopic, base, lc, topicAddr, words, type VenueAdapter } from "./common.ts";

export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

export function decodeTransferFlow(l: Log, markets: Market[]): RawTrade | null {
  if (l.topics[0] !== TRANSFER || l.topics.length < 3) return null;
  const from = addrFromTopic(l.topics[1]!), to = addrFromTopic(l.topics[2]!);
  const set = new Set(markets.map((m) => lc(m.address)));
  const fromM = set.has(lc(from)), toM = set.has(lc(to));
  if (fromM === toM) return null;
  const m = markets.find((x) => lc(x.address) === lc(fromM ? from : to))!;
  return {
    venue: "transfer-flow", market: m.address, token: m.token, side: fromM ? "buy" : "sell",
    tokenAmount: words(l.data)[0] ?? 0n, quoteAmount: null,
    eventSender: from, eventRecipient: to,
    ...base(l),
  };
}

export const transferFlow: VenueAdapter = {
  name: "transfer-flow",
  async discover(_rpc, token, o) {
    return (o.pools ?? []).map((p) => ({ venue: "transfer-flow", address: p, token, quote: null }));
  },
  async fetch(rpc, markets, fromBlock, toBlock) {
    if (!markets.length) return [];
    const token = markets[0].token;
    const addrs = markets.map((m) => topicAddr(m.address));
    const a = await rpc.getLogs({ address: token, topics: [TRANSFER, addrs], fromBlock, toBlock });
    const b = await rpc.getLogs({ address: token, topics: [TRANSFER, null, addrs], fromBlock, toBlock });
    const seen = new Set<string>();
    const out: RawTrade[] = [];
    for (const l of [...a, ...b]) {
      const k = `${l.transactionHash}:${l.logIndex}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const t = decodeTransferFlow(l, markets);
      if (t) out.push(t);
    }
    return out;
  },
};
