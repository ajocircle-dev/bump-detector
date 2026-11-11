// Attribute each trade to the real wallet. Routers, aggregators and the Universal
// Router appear as the event sender; the wallet that signed the tx is tx.from.
// For ERC-4337 bundles (tx.from is a bundler) we follow the token Transfer flow.
import type { Address, Log } from "viem";
import type { RawTrade, Trade } from "./types.ts";
import type { Rpc } from "./rpc.ts";
import { pMap } from "./rpc.ts";
import { ENTRYPOINTS, routerLabel, type ChainPreset } from "./chains.ts";
import { TRANSFER } from "./adapters/transferFlow.ts";
import { addrFromTopic } from "./adapters/common.ts";

const lc = (a: string) => a.toLowerCase();

/// Pure: follow the token's Transfer hops inside one tx to find the end wallet.
/// Buy: market -> (router ->)* wallet. Sell: wallet -> (router ->)* market.
export function flowTrader(logs: Log[], token: Address, market: Address, side: "buy" | "sell"): Address | null {
  const ts = logs
    .filter((l) => lc(l.address) === lc(token) && l.topics[0] === TRANSFER && l.topics.length >= 3)
    .map((l) => ({ from: addrFromTopic(l.topics[1]!), to: addrFromTopic(l.topics[2]!), i: Number(l.logIndex) }))
    .sort((a, b) => a.i - b.i);
  let cur: Address = market;
  let idx = side === "buy" ? -1 : Infinity;
  let out: Address | null = null;
  for (let hop = 0; hop < 8; hop++) {
    const nx = side === "buy"
      ? ts.find((t) => lc(t.from) === lc(cur) && t.i > idx)
      : [...ts].reverse().find((t) => lc(t.to) === lc(cur) && t.i < idx);
    if (!nx) break;
    cur = side === "buy" ? nx.to : nx.from;
    idx = nx.i;
    out = cur;
  }
  return out;
}

export async function attribute(
  rpc: Rpc, raws: RawTrade[],
  o: { preset?: ChainPreset; extraRouters?: Record<string, string>; forceFlow?: boolean } = {},
): Promise<Trade[]> {
  const hashes = [...new Set(raws.map((r) => r.tx))];
  const txs = new Map<string, { from: Address; to: Address | null; nonce: number }>();
  await pMap(hashes, async (h) => {
    const t = await rpc.tx(h);
    txs.set(h, { from: t.from, to: t.to ?? null, nonce: Number(t.nonce) });
  });
  const blocks = [...new Set(raws.map((r) => r.block))];
  const ts = new Map<number, number>();
  await pMap(blocks, async (b) => ts.set(b, await rpc.blockTime(b)));
  const receipts = new Map<string, Log[]>();
  const out: Trade[] = [];
  for (const r of raws) {
    const t = txs.get(r.tx)!;
    let trader: Address = t.from;
    let attribution: Trade["attribution"] = "tx.from";
    const viaEP = t.to && ENTRYPOINTS[lc(t.to)];
    if (viaEP || o.forceFlow) {
      if (!receipts.has(r.tx)) receipts.set(r.tx, (await rpc.client.getTransactionReceipt({ hash: r.tx })).logs as Log[]);
      const ft = flowTrader(receipts.get(r.tx)!, r.token, r.market, r.side);
      if (ft) {
        trader = ft;
        attribution = "transfer-flow";
      } else if (r.side === "buy" && r.eventRecipient) {
        trader = r.eventRecipient;
        attribution = "event";
      }
    }
    out.push({
      ...r, trader, attribution, via: t.to, viaLabel: routerLabel(o.preset, t.to, o.extraRouters),
      txNonce: attribution === "tx.from" ? t.nonce : null, timestamp: ts.get(r.block)!,
    });
  }
  return out;
}
