// Dump trades + wallet evidence for a token to a JSON fixture (public chain data only).
// node scripts/make-fixture.ts <rpc> <token> <fromBlock> <toBlock> <out.json>
import { writeFileSync } from "node:fs";
import { getAddress } from "viem";
import { makeRpc } from "../src/rpc.ts";
import { TokenDetector } from "../src/detect.ts";
import { enrich, enrichCandidates, DEFAULT_ENRICH } from "../src/enrich.ts";
import { PRESETS } from "../src/chains.ts";

const [rpcUrl, token, from, to, out] = process.argv.slice(2);
const rpc = await makeRpc(rpcUrl);
const preset = Object.values(PRESETS).find((p) => p.id === rpc.chainId);
const d = new TokenDetector(rpc, getAddress(token), { venues: "auto", pools: [], quotes: [], preset });
await d.init(Number(from), Number(to));
await d.update(Number(to));
const wallets = await enrich(rpc, d.token, d.trades, enrichCandidates(d.trades, 60), DEFAULT_ENRICH);
const ser = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? `${v}n` : v), 1);
writeFileSync(out, ser({ chainId: rpc.chainId, token: d.token, markets: d.markets, fromBlock: Number(from), toBlock: Number(to), trades: d.trades, wallets: [...wallets.values()] }));
console.log(`wrote ${d.trades.length} trades, ${wallets.size} wallets to ${out}`);
