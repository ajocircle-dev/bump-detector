import type { Address, Hex } from "viem";
import type { Rpc } from "./rpc.ts";
import { ADAPTERS, type DiscoverOpts } from "./adapters/index.ts";
import { attribute } from "./attribution.ts";
import { enrich, enrichCandidates, DEFAULT_ENRICH, type EnrichOpts } from "./enrich.ts";
import { analyze, DEFAULT_PARAMS, type Params } from "./heuristics.ts";
import type { ChainPreset } from "./chains.ts";
import type { Market, RawTrade, Trade, TokenReport, WalletInfo } from "./types.ts";
import { ZERO } from "./adapters/common.ts";
import { discoverPoolsFromTransfers } from "./adapters/poolScan.ts";
import { markNative } from "./native.ts";

export interface DetectOpts {
  venues: string[] | "auto";
  pools: Address[];
  quotes: Address[];
  v4PoolIds?: Hex[];
  preset?: ChainPreset;
  extraRouters?: Record<string, string>;
  forceFlow?: boolean;
  params?: Params;
  enrich?: EnrichOpts;
  /// Factory-free discovery: probe counterparties of the token's Transfer logs for V2 / V3
  /// pools on every update. On by default with venues "auto".
  poolScan?: boolean;
}

export async function discoverMarkets(rpc: Rpc, token: Address, fromBlock: number, toBlock: number, o: DetectOpts): Promise<Market[]> {
  const d: DiscoverOpts = {
    quotes: o.quotes.length ? o.quotes : [...(o.preset?.weth ? [o.preset.weth] : []), ZERO],
    fromBlock, toBlock, pools: o.pools,
    v2Factories: o.preset?.uniswapV2Factories, v3Factories: o.preset?.uniswapV3Factories,
    v4PoolManager: o.preset?.uniswapV4PoolManager, v4PoolIds: o.v4PoolIds, ponsFactories: o.preset?.ponsFactories,
  };
  const names = o.venues === "auto" ? ["pons", "uniswap-v2", "uniswap-v3", "uniswap-v4"] : o.venues;
  const out: Market[] = [];
  const explicit = new Set(o.pools.map((p) => p.toLowerCase()));
  for (const n of names) {
    const a = ADAPTERS[n];
    if (!a) throw new Error(`unknown venue ${n}; known: ${Object.keys(ADAPTERS).join(", ")}`);
    for (const m of await a.discover(rpc, token, d)) {
      if (out.some((x) => x.address.toLowerCase() === m.address.toLowerCase() && x.poolId === m.poolId)) continue;
      m.discoveredBy ??= explicit.has(m.address.toLowerCase()) ? "explicit" : "factory";
      out.push(m);
    }
  }
  // fall back to raw Transfer flow for explicit pools no adapter recognised
  if (o.venues === "auto" || o.venues.includes("transfer-flow")) {
    const known = new Set(out.map((m) => m.address.toLowerCase()));
    const rest = o.pools.filter((p) => !known.has(p.toLowerCase()));
    if (rest.length) out.push(...(await ADAPTERS["transfer-flow"].discover(rpc, token, { ...d, pools: rest })));
  }
  await markNative(rpc, out, o.preset);
  return out;
}

export async function fetchTrades(rpc: Rpc, markets: Market[], fromBlock: number, toBlock: number): Promise<RawTrade[]> {
  const byVenue = new Map<string, Market[]>();
  for (const m of markets) {
    if (!byVenue.has(m.venue)) byVenue.set(m.venue, []);
    byVenue.get(m.venue)!.push(m);
  }
  const out: RawTrade[] = [];
  for (const [v, ms] of byVenue) out.push(...(await ADAPTERS[v].fetch(rpc, ms, fromBlock, toBlock)));
  return out;
}

/// Stateful detector for one token. scan() = one shot; update() = incremental (watch).
export class TokenDetector {
  trades: Trade[] = [];
  seen = new Set<string>();
  walletCache = new Map<string, WalletInfo>();
  markets: Market[] = [];
  probed = new Set<string>();
  lastBlock = -1;
  firstBlock = -1;
  rpc: Rpc;
  token: Address;
  o: DetectOpts;
  constructor(rpc: Rpc, token: Address, o: DetectOpts) {
    this.rpc = rpc;
    this.token = token;
    this.o = o;
  }

  async init(fromBlock: number, toBlock: number) {
    this.markets = await discoverMarkets(this.rpc, this.token, fromBlock, toBlock, this.o);
    this.firstBlock = fromBlock;
    this.lastBlock = fromBlock - 1;
  }

  async update(toBlock: number): Promise<number> {
    if (toBlock <= this.lastBlock) return 0;
    const raw = await fetchTrades(this.rpc, this.markets, this.lastBlock + 1, toBlock);
    if (this.o.venues === "auto" && this.o.poolScan !== false) {
      // pools that first appear in this range: add them and backfill from the start
      const found = await discoverPoolsFromTransfers(this.rpc, this.token, this.lastBlock + 1, toBlock, {
        known: new Set(this.markets.map((m) => m.address.toLowerCase())),
        probed: this.probed,
        skip: this.o.preset?.uniswapV4PoolManager ? [this.o.preset.uniswapV4PoolManager] : [],
      });
      if (found.length) {
        found.forEach((m) => (m.discoveredBy = "pool-scan"));
        await markNative(this.rpc, found, this.o.preset);
        this.markets.push(...found);
        raw.push(...(await fetchTrades(this.rpc, found, this.firstBlock, toBlock)));
      }
    }
    this.lastBlock = toBlock;
    const fresh = raw.filter((r) => !this.seen.has(`${r.tx}:${r.logIndex}`));
    fresh.forEach((r) => this.seen.add(`${r.tx}:${r.logIndex}`));
    if (fresh.length) this.trades.push(...(await attribute(this.rpc, fresh, { preset: this.o.preset, extraRouters: this.o.extraRouters, forceFlow: this.o.forceFlow })));
    return fresh.length;
  }

  async report(): Promise<TokenReport> {
    const e = this.o.enrich ?? DEFAULT_ENRICH;
    const cands = enrichCandidates(this.trades, e.maxWallets);
    const wallets = await enrich(this.rpc, this.token, this.trades, cands, e, this.walletCache);
    return analyze(this.rpc.chainId, this.token, this.markets, this.firstBlock, this.lastBlock, this.trades, wallets, this.o.params ?? DEFAULT_PARAMS);
  }
}
