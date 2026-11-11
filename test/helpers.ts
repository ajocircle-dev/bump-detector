import { readFileSync } from "node:fs";
import type { Trade, WalletInfo } from "../src/types.ts";

export function loadFixture(p: string) {
  const j = JSON.parse(readFileSync(new URL(`./fixtures/${p}`, import.meta.url), "utf8"), (_k, v) =>
    typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  );
  const wallets = new Map<string, WalletInfo>((j.wallets as WalletInfo[]).map((w) => [w.address.toLowerCase(), w]));
  return { ...j, trades: j.trades as Trade[], wallets };
}

let seed = 1;
export function rand() {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}
export const addr = (i: number) => `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`;
export const hash = (i: number) => `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`;

let n = 0;
export function trade(p: Partial<Trade> & { trader: `0x${string}`; side: "buy" | "sell"; timestamp: number }): Trade {
  n++;
  return {
    venue: "uniswap-v2", market: addr(0xabc), token: addr(0x70c), tokenAmount: 1000n, quoteAmount: 10n,
    block: p.timestamp * 4, logIndex: n, txIndex: 0, tx: hash(n), attribution: "tx.from", via: null, viaLabel: null,
    txNonce: 50, ...p,
  };
}

/// Organic-looking tape: many independent wallets, random sizes and times.
export function organic(count: number, wallets: number, start = 1000): Trade[] {
  const out: Trade[] = [];
  let t = start;
  for (let i = 0; i < count; i++) {
    t += Math.floor(rand() * 90) + 5;
    const w = addr(0x1000 + Math.floor(rand() * wallets));
    const side = rand() < 0.6 ? "buy" : "sell";
    out.push(trade({ trader: w, side, timestamp: t, quoteAmount: BigInt(Math.floor(rand() * 1e6) + 1), tokenAmount: BigInt(Math.floor(rand() * 1e9) + 1), txNonce: Math.floor(rand() * 400) + 3 }));
  }
  return out;
}

/// Synthetic bump: k fresh wallets, cycles of b buys + s sells, rotating seller.
export function bump(k: number, cycles: number, b: number, s: number, gap: number, start = 1000) {
  const ws = Array.from({ length: k }, (_, i) => addr(0x9000 + i));
  const out: Trade[] = [];
  const nonce = new Map<string, number>();
  const nx = (w: string) => {
    const v = nonce.get(w) ?? 0;
    nonce.set(w, v + 1);
    return v;
  };
  let t = start, seller = 0;
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < b; i++) {
      const w = ws[(c + i) % k];
      out.push(trade({ trader: w, side: "buy", timestamp: t, quoteAmount: 100n + BigInt(i), tokenAmount: 1000n, txNonce: nx(w) }));
    }
    for (let i = 0; i < s; i++) {
      const w = ws[seller++ % k];
      out.push(trade({ trader: w, side: "sell", timestamp: t + 1, quoteAmount: (100n * BigInt(b)) / BigInt(s || 1), tokenAmount: (1000n * BigInt(b)) / BigInt(s || 1), txNonce: nx(w) }));
    }
    t += Math.round(gap * (0.8 + rand() * 0.4));
  }
  return { ws, trades: out };
}
