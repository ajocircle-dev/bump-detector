// Native-token handling. Routers and aggregators wrap ETH into WETH before it reaches a
// V2 / V3 pool and unwrap it on the way out, while V4 pools can hold native ETH directly
// as currency 0x0. Both cases are the native token, so markets quoted in WETH or 0x0 are
// marked nativeQuote and their quote volume is reported in ETH.
import type { Address } from "viem";
import type { Market } from "./types.ts";
import type { Rpc } from "./rpc.ts";
import type { ChainPreset } from "./chains.ts";
import { ZERO } from "./adapters/common.ts";

const lc = (a: string) => a.toLowerCase();

// Canonical wrapped-native addresses on common chains (public deployments).
export const KNOWN_WRAPPED_NATIVE: ReadonlySet<string> = new Set([
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH, Ethereum
  "0x4200000000000000000000000000000000000006", // WETH, OP stack (Base, Optimism)
  "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH, Arbitrum One
]);

const symbolAbi = [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const;

/// Pure part: decide from addresses alone. Returns null when an on-chain symbol check is needed.
export function nativeByAddress(quote: Address | null, preset?: ChainPreset, extra: Address[] = []): boolean | null {
  if (!quote) return false;
  if (lc(quote) === lc(ZERO)) return true;
  if (KNOWN_WRAPPED_NATIVE.has(lc(quote))) return true;
  if (preset?.weth && lc(preset.weth) === lc(quote)) return true;
  if (extra.some((e) => lc(e) === lc(quote))) return true;
  return null;
}

export async function markNative(rpc: Rpc, markets: Market[], preset?: ChainPreset, extra: Address[] = [], cache = new Map<string, boolean>()): Promise<void> {
  for (const m of markets) {
    if (m.nativeQuote !== undefined) continue;
    const byAddr = nativeByAddress(m.quote, preset, extra);
    if (byAddr !== null) {
      m.nativeQuote = byAddr;
      continue;
    }
    const k = lc(m.quote!);
    if (!cache.has(k)) {
      let sym = "";
      try {
        sym = String(await rpc.client.readContract({ address: m.quote!, abi: symbolAbi, functionName: "symbol" }));
      } catch {
        /* no symbol() */
      }
      cache.set(k, sym === "WETH" || sym === "WNATIVE");
    }
    m.nativeQuote = cache.get(k)!;
  }
}
