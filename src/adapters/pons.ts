// Pons-style bonding curves (Pons v2 on Robinhood Chain, and any curve that emits
// the same CurveBuy / CurveSell events).
import type { Address, Hex, Log } from "viem";
import type { Market, RawTrade } from "../types.ts";
import { addrFromTopic, base, lc, readAddr, topicAddr, words, type VenueAdapter } from "./common.ts";

export const CURVE_BUY = "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455" as const; // CurveBuy(address,address,uint256,uint256,uint256,uint256)
export const CURVE_SELL = "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df" as const; // CurveSell(address,address,uint256,uint256,uint256,uint256)
export const PONS_TOKEN_LAUNCHED = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607" as const; // topics: token, curve, creator

export function decodePons(l: Log, m: Market): RawTrade | null {
  const t0 = l.topics[0];
  if (t0 !== CURVE_BUY && t0 !== CURVE_SELL) return null;
  const [a, b] = words(l.data);
  const buy = t0 === CURVE_BUY;
  return {
    venue: "pons", market: m.address, token: m.token, side: buy ? "buy" : "sell",
    tokenAmount: buy ? b : a, quoteAmount: buy ? a : b,
    eventSender: addrFromTopic(l.topics[1]!), eventRecipient: addrFromTopic(l.topics[2]!),
    ...base(l),
  };
}

export interface Launch {
  token: Address;
  curve: Address;
  creator: Address;
  block: number;
  tx: Hex;
}

export async function ponsLaunches(rpc: { getLogs: (p: never) => Promise<Log[]> } & object, factories: Address[], fromBlock: number, toBlock: number, token?: Address): Promise<Launch[]> {
  const r = rpc as unknown as import("../rpc.ts").Rpc;
  const logs = await r.getLogs({ address: factories, topics: token ? [PONS_TOKEN_LAUNCHED, topicAddr(token)] : [PONS_TOKEN_LAUNCHED], fromBlock, toBlock });
  return logs.map((l) => ({
    token: addrFromTopic(l.topics[1]!), curve: addrFromTopic(l.topics[2]!), creator: addrFromTopic(l.topics[3]!),
    block: Number(l.blockNumber), tx: l.transactionHash as Hex,
  }));
}

export const pons: VenueAdapter = {
  name: "pons",
  async discover(rpc, token, o) {
    const out: Market[] = [];
    for (const p of o.pools ?? []) {
      const t = await readAddr(rpc, p, "token");
      if (t && lc(t) === lc(token)) out.push({ venue: "pons", address: p, token, quote: null });
    }
    if (o.ponsFactories?.length) {
      for (const l of await ponsLaunches(rpc as never, o.ponsFactories, 0, o.toBlock, token))
        if (!out.some((m) => lc(m.address) === lc(l.curve))) out.push({ venue: "pons", address: l.curve, token, quote: null });
    }
    return out;
  },
  async fetch(rpc, markets, fromBlock, toBlock) {
    if (!markets.length) return [];
    const byAddr = new Map(markets.map((m) => [lc(m.address), m]));
    const logs = await rpc.getLogs({ address: markets.map((m) => m.address), topics: [[CURVE_BUY, CURVE_SELL]], fromBlock, toBlock });
    return logs.map((l) => decodePons(l, byAddr.get(lc(l.address))!)).filter((x): x is RawTrade => !!x);
  },
};
