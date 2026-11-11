import { getAddress, pad, type Address, type Hex, type Log } from "viem";
import type { Market, RawTrade } from "../types.ts";
import type { Rpc } from "../rpc.ts";

export interface DiscoverOpts {
  quotes: Address[]; // candidate quote assets (WETH, native = 0x0, stables)
  fromBlock: number;
  toBlock: number;
  pools?: Address[]; // explicit pools / curves / markets
  v2Factories?: Address[];
  v3Factories?: Address[];
  v4PoolManager?: Address;
  v4PoolIds?: Hex[];
  ponsFactories?: Address[];
}

export interface VenueAdapter {
  name: string;
  /// Find markets for a token. Return [] if the venue does not apply.
  discover(rpc: Rpc, token: Address, o: DiscoverOpts): Promise<Market[]>;
  /// Fetch and decode trades for markets of this venue in a block range.
  fetch(rpc: Rpc, markets: Market[], fromBlock: number, toBlock: number): Promise<RawTrade[]>;
}

export const ZERO = "0x0000000000000000000000000000000000000000" as Address;
export const topicAddr = (a: Address): Hex => pad(a.toLowerCase() as Hex, { size: 32 });
export const addrFromTopic = (t: Hex): Address => getAddress(`0x${t.slice(26)}`);
export const lc = (a: string) => a.toLowerCase();

export function words(data: Hex): bigint[] {
  const d = data.slice(2);
  const out: bigint[] = [];
  for (let i = 0; i + 64 <= d.length; i += 64) out.push(BigInt(`0x${d.slice(i, i + 64)}`));
  return out;
}
export function signed(x: bigint, bits = 256): bigint {
  const lim = 1n << BigInt(bits - 1);
  const v = x & ((1n << BigInt(bits)) - 1n);
  return v >= lim ? v - (1n << BigInt(bits)) : v;
}
export const abs = (x: bigint) => (x < 0n ? -x : x);

export function base(l: Log): Pick<RawTrade, "block" | "logIndex" | "txIndex" | "tx"> {
  return {
    block: Number(l.blockNumber),
    logIndex: Number(l.logIndex),
    txIndex: Number(l.transactionIndex),
    tx: l.transactionHash as Hex,
  };
}

export async function readAddr(rpc: Rpc, address: Address, fn: string): Promise<Address | null> {
  try {
    return (await rpc.client.readContract({
      address,
      abi: [{ type: "function", name: fn, stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
      functionName: fn,
    })) as Address;
  } catch {
    return null;
  }
}
