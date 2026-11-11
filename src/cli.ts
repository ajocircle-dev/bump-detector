#!/usr/bin/env node
// bump-detector: read-only fake-volume detector for EVM tokens.
import { parseArgs } from "node:util";
import { writeFileSync, appendFileSync } from "node:fs";
import { getAddress, type Address, type Hex } from "viem";
import { makeRpc } from "./rpc.ts";
import { PRESETS, type ChainPreset } from "./chains.ts";
import { TokenDetector, type DetectOpts } from "./detect.ts";
import { DEFAULT_PARAMS } from "./heuristics.ts";
import { DEFAULT_ENRICH } from "./enrich.ts";
import { ponsLaunches } from "./adapters/pons.ts";
import { toJson, table, detail } from "./report.ts";
import type { TokenReport } from "./types.ts";

const HELP = `bump-detector <scan|watch|launchpad> [options]

  --chain <name>        preset: ${Object.keys(PRESETS).join(", ")}
  --rpc <url>           any EVM JSON-RPC (overrides the preset RPC; read-only use)
  --token <addr>        token to score (scan, watch)
  --venue <list>        auto (default) or comma list: uniswap-v2,uniswap-v3,uniswap-v4,pons,transfer-flow
  --pool <list>         explicit pool / pair / curve / market addresses
  --quote <list>        quote assets for pool discovery (default: preset WETH and native)
  --v4-pool-id <list>   restrict Uniswap V4 pools
  --router <a=label>    extra router labels, comma separated
  --force-flow          attribute every trade by Transfer flow instead of tx.from
  --from-block <n>      start block (default: head - lookback)
  --lookback <n>        blocks back from head when --from-block is not set (default 20000)
  --to-block <n>        end block (default: head)
  --window-sec <n>      funding / sweep scan window around trades (default ${DEFAULT_ENRICH.windowSec})
  --threshold <n>       flag score threshold (default ${DEFAULT_PARAMS.flagThreshold})
  --burst-gap <sec>     max gap inside one burst (default ${DEFAULT_PARAMS.burstGapSec})
  --json <file>         write the JSON report
  --interval <sec>      watch poll interval (default 4)
  --out <file>          watch: append each new report as a JSON line
  --factory <list>      launchpad: launch factories (default: preset Pons factory)
  --min-trades <n>      launchpad: skip tokens with fewer trades (default 12)
  --quiet               only print the table
`;

const { positionals, values: v } = parseArgs({
  allowPositionals: true,
  options: {
    chain: { type: "string" }, rpc: { type: "string" }, token: { type: "string" }, venue: { type: "string" },
    pool: { type: "string" }, quote: { type: "string" }, "v4-pool-id": { type: "string" }, router: { type: "string" },
    "force-flow": { type: "boolean" }, "from-block": { type: "string" }, lookback: { type: "string" }, "to-block": { type: "string" },
    "window-sec": { type: "string" }, threshold: { type: "string" }, "burst-gap": { type: "string" }, json: { type: "string" },
    interval: { type: "string" }, out: { type: "string" }, factory: { type: "string" }, "min-trades": { type: "string" },
    quiet: { type: "boolean" }, help: { type: "boolean" },
  },
});
const list = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
const addrs = (s?: string) => list(s).map((x) => getAddress(x));

async function main() {
  const cmd = positionals[0];
  if (!cmd || v.help) return void console.log(HELP);
  const preset: ChainPreset | undefined = v.chain ? PRESETS[v.chain] : undefined;
  if (v.chain && !preset) throw new Error(`unknown chain ${v.chain}`);
  const url = v.rpc ?? preset?.rpc;
  if (!url) throw new Error("--rpc or --chain required");
  const rpc = await makeRpc(url);
  if (preset && preset.id !== rpc.chainId) throw new Error(`RPC chain id ${rpc.chainId} does not match preset ${preset.name} (${preset.id})`);
  const head = await rpc.head();
  const toBlock = v["to-block"] ? Number(v["to-block"]) : head;
  const fromBlock = v["from-block"] ? Number(v["from-block"]) : Math.max(0, toBlock - Number(v.lookback ?? 20000));
  const extraRouters: Record<string, string> = {};
  for (const kv of list(v.router)) {
    const [a, l] = kv.split("=");
    extraRouters[a.toLowerCase()] = l ?? "custom router";
  }
  const o: DetectOpts = {
    venues: !v.venue || v.venue === "auto" ? "auto" : list(v.venue),
    pools: addrs(v.pool), quotes: addrs(v.quote), v4PoolIds: list(v["v4-pool-id"]) as Hex[],
    preset, extraRouters, forceFlow: !!v["force-flow"],
    params: { ...DEFAULT_PARAMS, flagThreshold: Number(v.threshold ?? DEFAULT_PARAMS.flagThreshold), burstGapSec: Number(v["burst-gap"] ?? DEFAULT_PARAMS.burstGapSec) },
    enrich: { ...DEFAULT_ENRICH, windowSec: Number(v["window-sec"] ?? DEFAULT_ENRICH.windowSec) },
  };
  const print = (rs: TokenReport[]) => {
    console.log(table(rs));
    if (!v.quiet) for (const r of rs) console.log("\n" + detail(r));
  };

  if (cmd === "scan") {
    if (!v.token) throw new Error("--token required");
    const d = new TokenDetector(rpc, getAddress(v.token), o);
    await d.init(fromBlock, toBlock);
    await d.update(toBlock);
    const r = await d.report();
    print([r]);
    if (v.json) writeFileSync(v.json, toJson(r));
    return;
  }

  if (cmd === "watch") {
    if (!v.token) throw new Error("--token required");
    const d = new TokenDetector(rpc, getAddress(v.token), o);
    await d.init(fromBlock, toBlock);
    await d.update(toBlock);
    const interval = Number(v.interval ?? 4) * 1000;
    let lastKey = "";
    console.log(`watching ${v.token} on chain ${rpc.chainId} from block ${fromBlock}, markets: ${d.markets.map((m) => `${m.venue}@${m.address}`).join(", ") || "none"}`);
    let stop = false;
    process.on("SIGINT", () => (stop = true));
    process.on("SIGTERM", () => (stop = true));
    let pendingNew = true;
    let lastReport = 0;
    const refreshMs = 30_000; // re-check evidence (e.g. sweeps after the last trade) even with no new trades
    while (!stop) {
      const h = await rpc.head();
      const n = await d.update(h);
      if (n || (d.trades.length && Date.now() - lastReport > refreshMs)) pendingNew = true;
      if (pendingNew) {
        const r = await d.report();
        lastReport = Date.now();
        const key = `${r.score}|${r.stats.trades}|${r.clusters.map((c) => `${c.score}:${c.wallets.length}:${c.evidence.sweepTxs.length}`).join(",")}`;
        if (key !== lastKey) {
          lastKey = key;
          console.log(`\n[${new Date().toISOString()}] block ${h} +${n} trades`);
          print([r]);
          if (v.out) appendFileSync(v.out, JSON.stringify(r, (_k, x) => (typeof x === "bigint" ? x.toString() : x)) + "\n");
          if (v.json) writeFileSync(v.json, toJson(r));
        }
        pendingNew = false;
      }
      await new Promise((res) => setTimeout(res, interval));
    }
    return;
  }

  if (cmd === "launchpad") {
    const factories = v.factory ? addrs(v.factory) : preset?.ponsFactories ?? [];
    if (!factories.length) throw new Error("--factory required (no preset launch factory)");
    const launches = await ponsLaunches(rpc as never, factories, fromBlock, toBlock);
    console.error(`found ${launches.length} launches in blocks ${fromBlock}..${toBlock}`);
    const min = Number(v["min-trades"] ?? 12);
    const reports: TokenReport[] = [];
    for (const l of launches) {
      const d = new TokenDetector(rpc, l.token, { ...o, venues: ["pons"], pools: [l.curve] });
      await d.init(l.block, toBlock);
      await d.update(toBlock);
      if (d.trades.length < min) continue;
      reports.push(await d.report());
    }
    reports.sort((a, b) => b.score - a.score);
    print(reports);
    if (v.json) writeFileSync(v.json, toJson(reports));
    return;
  }
  console.log(HELP);
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
