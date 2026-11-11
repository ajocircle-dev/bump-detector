import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, bursts, candidateClusters, DEFAULT_PARAMS } from "../src/heuristics.ts";
import type { WalletInfo } from "../src/types.ts";
import { loadFixture, organic, bump, addr, hash } from "./helpers.ts";

const MASTER = "0x8c783b2c1c58922d8cf31b453bd8b87db9f9a90e";
const TRIO = ["0x4ccac3d93f63d79149750e5cbea30a5dbcb15f69", "0xbe6943b0e3c3db1f0595e3b57b177b28c6216f16", "0xd02919841c8ee4a9fcc390d936595bdef5766610"];

test("MentatBot on Pons (real mainnet fixture) is flagged with the 3-wallet cluster", () => {
  const f = loadFixture("mentatbot-pons-4663.json");
  const r = analyze(f.chainId, f.token, f.markets, f.fromBlock, f.toBlock, f.trades, f.wallets);
  assert.equal(r.verdict, "likely-bump");
  const c = r.clusters[0];
  assert.equal(c.basis, "common-funder");
  assert.equal(c.funder?.toLowerCase(), MASTER);
  assert.deepEqual([...c.wallets].map((w) => w.toLowerCase()).sort(), [...TRIO].sort());
  assert.equal(c.features.dominantShape, "2B/1S");
  assert.ok((c.features.gapMeanSec as number) > 8 && (c.features.gapMeanSec as number) < 12);
  assert.equal(c.evidence.fundingTxs.length, 3);
  // the launch buy by the deployer is not flagged
  assert.ok(!r.flaggedWallets.includes("0xf2aefb9c67b958feeae6af0fe39b119236a9580e" as never));
});

test("MentatBot still flagged without any funding evidence (pattern only)", () => {
  const f = loadFixture("mentatbot-pons-4663.json");
  const bare = new Map<string, WalletInfo>([...f.wallets].map(([k, w]) => [k, { ...w, funding: null, sweep: null }]));
  const r = analyze(f.chainId, f.token, f.markets, f.fromBlock, f.toBlock, f.trades, bare);
  assert.equal(r.clusters[0].basis, "co-trading");
  assert.ok(r.score >= DEFAULT_PARAMS.flagThreshold, `score ${r.score}`);
});

test("organic tape is not flagged", () => {
  const t = organic(300, 120);
  const r = analyze(1, addr(0x70c), [], 0, 0, t, new Map());
  assert.notEqual(r.verdict, "likely-bump");
  assert.ok(r.score < DEFAULT_PARAMS.suspiciousThreshold, `score ${r.score}`);
});

test("5-buy/2-sell bump with equal funding is flagged inside organic flow", () => {
  const { ws, trades } = bump(5, 25, 5, 2, 10, 5000);
  const org = organic(150, 80, 4000);
  const wallets = new Map<string, WalletInfo>(
    ws.map((w, i) => [w.toLowerCase(), { address: w, firstNonce: 0, funding: { funder: addr(0xf00d), amount: 2_000_000n, tx: hash(0xf000 + i), block: 1 }, sweep: { to: addr(0xf00d), amount: 1n, tx: hash(0xe000 + i), block: 99999 }, approvals: [] }]),
  );
  const r = analyze(1, addr(0x70c), [], 0, 0, [...org, ...trades], wallets);
  assert.equal(r.verdict, "likely-bump");
  const c = r.clusters[0];
  assert.equal(c.features.dominantShape, "5B/2S");
  assert.deepEqual(new Set(c.wallets.map((w) => w.toLowerCase())), new Set(ws.map((w) => w.toLowerCase())));
  const bumpTx = new Set(trades.map((t) => t.tx));
  const flaggedTrades = r.flaggedTxs.filter((h) => bumpTx.has(h));
  assert.equal(flaggedTrades.length, bumpTx.size, "recall on trades = 1");
  const orgTx = new Set(org.map((t) => t.tx));
  assert.equal(r.flaggedTxs.filter((h) => orgTx.has(h)).length, 0, "no organic tx flagged");
});

test("common funder with unequal amounts and random timing is not likely-bump", () => {
  const org = organic(120, 6);
  const ws = [...new Set(org.map((t) => t.trader.toLowerCase()))];
  const wallets = new Map<string, WalletInfo>(
    ws.map((w, i) => [w, { address: w as never, firstNonce: 40, funding: { funder: addr(0xcec), amount: BigInt(1000 * (i + 1) ** 3), tx: hash(0xc000 + i), block: 1 }, sweep: null, approvals: [] }]),
  );
  const r = analyze(1, addr(0x70c), [], 0, 0, org, wallets);
  assert.notEqual(r.verdict, "likely-bump", `score ${r.score}`);
});

test("bursts split on the gap threshold", () => {
  const { trades } = bump(3, 4, 2, 1, 10);
  assert.equal(bursts(trades, 3).length, 4);
});

test("co-trading clusters form without funding data", () => {
  const { ws, trades } = bump(3, 10, 2, 1, 10);
  const c = candidateClusters(trades, new Map(), DEFAULT_PARAMS);
  assert.equal(c.length, 1);
  assert.equal(c[0].wallets.length, ws.length);
});
