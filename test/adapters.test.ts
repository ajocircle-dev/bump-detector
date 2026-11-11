import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, pad, type Hex, type Log } from "viem";
import { decodeV2, V2_SWAP } from "../src/adapters/uniswapV2.ts";
import { decodeV3, V3_SWAP } from "../src/adapters/uniswapV3.ts";
import { decodeV4, V4_SWAP } from "../src/adapters/uniswapV4.ts";
import { decodePons, CURVE_BUY, CURVE_SELL } from "../src/adapters/pons.ts";
import { decodeTransferFlow, TRANSFER } from "../src/adapters/transferFlow.ts";
import { flowTrader } from "../src/attribution.ts";
import type { Market } from "../src/types.ts";

const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const T = (a: Hex) => pad(a, { size: 32 });
const log = (address: Hex, topics: Hex[], data: Hex, logIndex = 1): Log =>
  ({ address, topics, data, blockNumber: 10n, logIndex, transactionIndex: 0, transactionHash: `0x${"ab".repeat(32)}`, blockHash: null, removed: false }) as unknown as Log;
const token = A(0x70c), pool = A(0x9001), router = A(0x7777), user = A(0xaaaa);

test("v2 buy and sell, token as token0 and token1", () => {
  const m0: Market = { venue: "uniswap-v2", address: pool, token, quote: A(1), tokenIndex: 0 };
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [0n, 5n, 900n, 0n]);
  const b = decodeV2(log(pool, [V2_SWAP, T(router), T(user)], data), m0)!;
  assert.equal(b.side, "buy");
  assert.equal(b.tokenAmount, 900n);
  assert.equal(b.quoteAmount, 5n);
  const m1 = { ...m0, tokenIndex: 1 as const };
  const s = decodeV2(log(pool, [V2_SWAP, T(router), T(user)], data), m1)!;
  assert.equal(s.side, "sell");
  assert.equal(s.tokenAmount, 5n);
  assert.equal(s.quoteAmount, 900n);
});

test("v3 signs are pool-perspective", () => {
  const m: Market = { venue: "uniswap-v3", address: pool, token, quote: A(1), tokenIndex: 1 };
  const data = encodeAbiParameters(
    [{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }],
    [1000n, -50000n, 1n, 1n, 0],
  );
  const t = decodeV3(log(pool, [V3_SWAP, T(router), T(user)], data), m)!;
  assert.equal(t.side, "buy");
  assert.equal(t.tokenAmount, 50000n);
  assert.equal(t.quoteAmount, 1000n);
});

test("v4 signs are swapper-perspective and pool id is checked", () => {
  const id = `0x${"11".repeat(32)}` as Hex;
  const m: Market = { venue: "uniswap-v4", address: pool, token, quote: A(0), tokenIndex: 1, poolId: id };
  const data = encodeAbiParameters(
    [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
    [-1000n, 42000n, 1n, 1n, 0, 3000],
  );
  const t = decodeV4(log(pool, [V4_SWAP, id, T(router)], data), m)!;
  assert.equal(t.side, "buy");
  assert.equal(t.tokenAmount, 42000n);
  assert.equal(t.quoteAmount, 1000n);
  assert.equal(decodeV4(log(pool, [V4_SWAP, `0x${"22".repeat(32)}`, T(router)], data), m), null);
});

test("pons CurveBuy / CurveSell decode", () => {
  const m: Market = { venue: "pons", address: pool, token, quote: null };
  const d = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [100n, 9999n, 1n, 0n]);
  assert.equal(decodePons(log(pool, [CURVE_BUY, T(user), T(user)], d), m)!.tokenAmount, 9999n);
  const s = decodePons(log(pool, [CURVE_SELL, T(user), T(user)], d), m)!;
  assert.equal(s.side, "sell");
  assert.equal(s.tokenAmount, 100n);
  assert.equal(s.quoteAmount, 9999n);
});

test("transfer-flow fallback", () => {
  const m: Market = { venue: "transfer-flow", address: pool, token, quote: null };
  const d = encodeAbiParameters([{ type: "uint256" }], [77n]);
  assert.equal(decodeTransferFlow(log(token, [TRANSFER, T(pool), T(user)], d), [m])!.side, "buy");
  assert.equal(decodeTransferFlow(log(token, [TRANSFER, T(user), T(pool)], d), [m])!.side, "sell");
  assert.equal(decodeTransferFlow(log(token, [TRANSFER, T(user), T(router)], d), [m]), null);
});

test("flowTrader follows router hops to the real wallet", () => {
  const d = encodeAbiParameters([{ type: "uint256" }], [5n]);
  const buyLogs = [log(token, [TRANSFER, T(pool), T(router)], d, 1), log(token, [TRANSFER, T(router), T(user)], d, 2)];
  assert.equal(flowTrader(buyLogs, token, pool, "buy")!.toLowerCase(), user);
  const sellLogs = [log(token, [TRANSFER, T(user), T(router)], d, 1), log(token, [TRANSFER, T(router), T(pool)], d, 2)];
  assert.equal(flowTrader(sellLogs, token, pool, "sell")!.toLowerCase(), user);
});
