// Launchpad / router agnostic paths: factory-free pool discovery, attribution through any
// router or aggregator, native ETH via WETH, and generic V2 / V3 launch discovery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, getAddress, pad, type Address, type Hex, type Log } from "viem";
import { rankCounterparties, discoverPoolsFromTransfers } from "../src/adapters/poolScan.ts";
import { TRANSFER } from "../src/adapters/transferFlow.ts";
import { V2_SWAP } from "../src/adapters/uniswapV2.ts";
import { V3_SWAP } from "../src/adapters/uniswapV3.ts";
import { attribute } from "../src/attribution.ts";
import { COMMON_ROUTERS } from "../src/chains.ts";
import { nativeByAddress, markNative } from "../src/native.ts";
import { decodeCreated, PAIR_CREATED, POOL_CREATED } from "../src/launches.ts";
import { TokenDetector } from "../src/detect.ts";
import type { Rpc } from "../src/rpc.ts";
import type { Market, RawTrade } from "../src/types.ts";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`) as Address;
const T = (a: Address) => pad(a.toLowerCase() as Hex, { size: 32 });
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const u256 = (...xs: bigint[]) => encodeAbiParameters(xs.map(() => ({ type: "uint256" })), xs);
let li = 0;
const log = (address: Address, topics: Hex[], data: Hex, block: number, tx: Hex): Log =>
  ({ address, topics, data, blockNumber: BigInt(block), logIndex: li++, transactionIndex: 0, transactionHash: tx, blockHash: null, removed: false }) as unknown as Log;

const token = A(0x70c), weth = A(0xeee), v2pool = A(0x9001), v3pool = A(0x9002), curve = A(0x9003);
const wallets = [A(0xa1), A(0xa2), A(0xa3)];

/// In-memory Rpc: logs, txs, code and a few view functions.
function mockRpc(logs: Log[], txFrom: Map<string, { from: Address; to: Address; nonce: number }>, views: Record<string, Record<string, unknown>>, code: Set<string>): Rpc {
  return {
    chainId: 46630,
    client: {
      getCode: async ({ address }: { address: Address }) => (code.has(address.toLowerCase()) ? "0x6000" : "0x"),
      readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
        const v = views[address.toLowerCase()]?.[functionName];
        if (v === undefined) throw new Error("revert");
        return v;
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => ({ logs: logs.filter((l) => l.transactionHash === hash) }),
    } as never,
    async getLogs({ address, topics, fromBlock, toBlock }) {
      const as = address ? (Array.isArray(address) ? address : [address]).map((a) => a.toLowerCase()) : null;
      return logs.filter((l) => {
        const b = Number(l.blockNumber);
        if (b < fromBlock || b > toBlock) return false;
        if (as && !as.includes(l.address.toLowerCase())) return false;
        return topics.every((t, i) => t === null || (Array.isArray(t) ? t.map((x) => x.toLowerCase()).includes(l.topics[i]?.toLowerCase() ?? "") : t.toLowerCase() === l.topics[i]?.toLowerCase()));
      });
    },
    async blockTime(n) {
      return 1_000_000 + n * 2;
    },
    async tx(h) {
      const t = txFrom.get(h)!;
      return { from: t.from, to: t.to, nonce: t.nonce } as never;
    },
    async block() {
      return { timestamp: 0, transactions: [] };
    },
    async head() {
      return 1000;
    },
  };
}

test("rankCounterparties orders by frequency and skips zero, token and excluded", () => {
  const logs = [
    log(token, [TRANSFER, T(A(0)), T(wallets[0])], u256(1n), 1, H(1)),
    log(token, [TRANSFER, T(v2pool), T(wallets[0])], u256(1n), 2, H(2)),
    log(token, [TRANSFER, T(wallets[1]), T(v2pool)], u256(1n), 3, H(3)),
    log(token, [TRANSFER, T(v2pool), T(wallets[2])], u256(1n), 4, H(4)),
    log(A(0xdead), [TRANSFER, T(curve), T(wallets[2])], u256(1n), 4, H(5)), // other token
  ];
  const r = rankCounterparties(logs, token, [wallets[2].toLowerCase()]);
  assert.equal(r[0], v2pool);
  assert.ok(!r.includes(A(0)) && !r.includes(wallets[2]) && !r.includes(curve));
});

test("pool scan finds V2, V3 and curve markets with no factory or preset", async () => {
  const logs = [
    log(token, [TRANSFER, T(v2pool), T(wallets[0])], u256(5n), 10, H(10)),
    log(token, [TRANSFER, T(wallets[1]), T(v3pool)], u256(5n), 11, H(11)),
    log(token, [TRANSFER, T(curve), T(wallets[2])], u256(5n), 12, H(12)),
    log(token, [TRANSFER, T(wallets[2]), T(A(0xc0de))], u256(5n), 12, H(13)), // contract that is not a pool
  ];
  const views = {
    [v2pool.toLowerCase()]: { getReserves: [1n, 1n, 1], token0: token, token1: weth },
    [v3pool.toLowerCase()]: { fee: 3000, token0: weth, token1: token },
    [curve.toLowerCase()]: { token },
  };
  const code = new Set([v2pool, v3pool, curve, A(0xc0de)].map((a) => a.toLowerCase()));
  const probed = new Set<string>();
  const ms = await discoverPoolsFromTransfers(mockRpc(logs, new Map(), views, code), token, 0, 100, { known: new Set(), probed });
  const by = Object.fromEntries(ms.map((m) => [m.address, m]));
  assert.equal(by[v2pool].venue, "uniswap-v2");
  assert.equal(by[v2pool].tokenIndex, 0);
  assert.equal(by[v3pool].venue, "uniswap-v3");
  assert.equal(by[v3pool].tokenIndex, 1);
  assert.equal(by[curve].venue, "pons");
  assert.equal(ms.length, 3);
  assert.ok(probed.has(A(0xc0de).toLowerCase()) && probed.has(wallets[0].toLowerCase()));
  // second call does not re-probe
  const again = await discoverPoolsFromTransfers(mockRpc(logs, new Map(), views, code), token, 0, 100, { known: new Set(ms.map((m) => m.address.toLowerCase())), probed });
  assert.equal(again.length, 0);
});

test("trades through any router or aggregator are credited to tx.from", async () => {
  const routers = Object.keys(COMMON_ROUTERS).map((a) => getAddress(a));
  const raws: RawTrade[] = [];
  const txs = new Map<string, { from: Address; to: Address; nonce: number }>();
  routers.forEach((r, i) => {
    const tx = H(100 + i);
    const w = wallets[i % wallets.length];
    txs.set(tx, { from: w, to: r, nonce: i });
    // the pool sees the router (or an aggregator executor) as sender, recipient may be anything
    raws.push({ venue: "uniswap-v2", market: v2pool, token, side: i % 2 ? "sell" : "buy", tokenAmount: 1n, quoteAmount: 1n, block: 50 + i, logIndex: 0, txIndex: 0, tx, eventSender: r, eventRecipient: A(0xe8ec) });
  });
  const out = await attribute(mockRpc([], txs, {}, new Set()), raws);
  out.forEach((t, i) => {
    assert.equal(t.trader, wallets[i % wallets.length]);
    assert.equal(t.attribution, "tx.from");
    assert.equal(t.via, routers[i]);
    assert.equal(t.viaLabel, COMMON_ROUTERS[routers[i].toLowerCase()]);
  });
});

test("native ETH: WETH and 0x0 quotes are marked native", async () => {
  assert.equal(nativeByAddress(A(0)), true);
  assert.equal(nativeByAddress(getAddress("0x4200000000000000000000000000000000000006")), true);
  assert.equal(nativeByAddress(null), false);
  assert.equal(nativeByAddress(weth), null); // unknown: needs a symbol() check
  const ms: Market[] = [
    { venue: "uniswap-v2", address: v2pool, token, quote: weth, tokenIndex: 0 },
    { venue: "uniswap-v3", address: v3pool, token, quote: A(0x05dc), tokenIndex: 1 },
  ];
  await markNative(mockRpc([], new Map(), { [weth.toLowerCase()]: { symbol: "WETH" }, [A(0x05dc).toLowerCase()]: { symbol: "USDC" } }, new Set()), ms);
  assert.equal(ms[0].nativeQuote, true);
  assert.equal(ms[1].nativeQuote, false);
});

test("generic launches: V2 PairCreated and V3 PoolCreated, token is the non-quote side", () => {
  const f = A(0xfac);
  const v2 = decodeCreated(log(f, [PAIR_CREATED, T(weth), T(token)], encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [v2pool, 7n]), 5, H(5)), [weth])!;
  assert.deepEqual([v2.kind, v2.token, v2.quote, v2.market, v2.venue], ["v2", token, weth, v2pool, "uniswap-v2"]);
  const v3 = decodeCreated(log(f, [POOL_CREATED, T(token), T(weth), pad("0xbb8", { size: 32 })], encodeAbiParameters([{ type: "int24" }, { type: "address" }], [60, v3pool]), 6, H(6)), [weth])!;
  assert.deepEqual([v3.kind, v3.token, v3.market, v3.venue], ["v3", token, v3pool, "uniswap-v3"]);
  assert.equal(decodeCreated(log(f, [PAIR_CREATED, T(A(1)), T(A(2))], encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [v2pool, 1n]), 5, H(7)), [weth]), null);
});

test("watch mode: a pool that appears later is discovered and backfilled", async () => {
  // block 20: buy on the V2 pool via a router; block 30: a V3 pool starts trading
  const logs: Log[] = [];
  const txs = new Map<string, { from: Address; to: Address; nonce: number }>();
  const router = getAddress("0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad");
  const add = (block: number, i: number, pool: Address, swap: Log) => {
    const tx = swap.transactionHash as Hex;
    txs.set(tx, { from: wallets[i % 3], to: router, nonce: i });
    logs.push(log(token, [TRANSFER, T(pool), T(wallets[i % 3])], u256(10n), block, tx), swap);
  };
  add(20, 0, v2pool, log(v2pool, [V2_SWAP, T(router), T(wallets[0])], u256(0n, 1n, 10n, 0n), 20, H(20)));
  add(30, 1, v3pool, log(v3pool, [V3_SWAP, T(router), T(wallets[1])], encodeAbiParameters([{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }], [5n, -10n, 1n, 1n, 0]), 30, H(30)));
  const views = {
    [v2pool.toLowerCase()]: { getReserves: [1n, 1n, 1], token0: token, token1: weth },
    [v3pool.toLowerCase()]: { fee: 500, token0: weth, token1: token },
    [weth.toLowerCase()]: { symbol: "WETH" },
  };
  const rpc = mockRpc(logs, txs, views, new Set([v2pool, v3pool].map((a) => a.toLowerCase())));
  const d = new TokenDetector(rpc, token, { venues: "auto", pools: [], quotes: [] });
  await d.init(10, 10);
  assert.equal(d.markets.length, 0);
  await d.update(25);
  assert.deepEqual(d.markets.map((m) => m.venue), ["uniswap-v2"]);
  assert.equal(d.trades.length, 1);
  await d.update(40);
  assert.deepEqual(d.markets.map((m) => m.venue).sort(), ["uniswap-v2", "uniswap-v3"]);
  assert.equal(d.trades.length, 2);
  assert.ok(d.markets.every((m) => m.discoveredBy === "pool-scan" && m.nativeQuote === true));
  assert.deepEqual(d.trades.map((t) => [t.trader, t.side, t.viaLabel]), [
    [wallets[0], "buy", "Uniswap Universal Router"],
    [wallets[1], "buy", "Uniswap Universal Router"],
  ]);
  // skip-pool-scan turns it off
  const d2 = new TokenDetector(rpc, token, { venues: "auto", pools: [], quotes: [], poolScan: false });
  await d2.init(10, 10);
  await d2.update(40);
  assert.equal(d2.trades.length, 0);
});
