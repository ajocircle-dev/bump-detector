# bump-detector

Read-only detector for fake volume on EVM tokens. It flags "bump bot" and wash-trading activity, where a small group of wallets controlled by one operator trades a token back and forth so the chart and the trade count look busy.

It is meant for:

- **Launchpads**, to label or delist tokens whose early volume is mostly self-trading.
- **Traders and tools**, to check whether a busy new chart is real before buying.
- **Researchers**, to measure how much of a venue's volume is recycled.

It only reads public chain data through a normal JSON-RPC endpoint. It never signs or sends transactions.

It is launchpad and router agnostic. It works on any ERC-20 traded against native ETH (directly, or as WETH) or against any other ERC-20, on any EVM chain. Trades are read from the pools themselves, so it does not matter whether a bump bot calls the pool through the Uniswap V2 router, the Universal Router, an aggregator (0x, 1inch, Odos, KyberSwap, ParaSwap), a launchpad router, or its own contract.

## How it works

1. **Market discovery.** Markets for the token are found three ways, and you can mix them:
   - **Pool scan (default, no configuration).** Every pool that holds the token shows up in the token's own `Transfer` logs. The detector ranks those counterparties, skips wallets (no code), and probes each contract for the Uniswap V2 interface (`getReserves`, `token0`, `token1`), the V3 interface (`fee`, `token0`, `token1`) or a Pons-style curve (`token()`). It runs again on every update in watch mode, so a pool created after the watch started is picked up and backfilled. No factory list, preset or launchpad knowledge is needed. Turn it off with `--skip-pool-scan`.
   - **Factories** from a chain preset (Uniswap V2 `getPair`, V3 `getPool` per fee tier, V4 `Initialize` logs on the PoolManager).
   - **Explicit** `--pool` addresses.
2. **Venue adapters** turn swap events into trades. Built in:
   - `uniswap-v2`: `Swap` on V2 style pairs (Uniswap V2 and forks).
   - `uniswap-v3`: `Swap` on V3 pools.
   - `uniswap-v4`: `Swap` on the V4 PoolManager, keyed by pool id (native ETH pools included).
   - `pons`: `CurveBuy` / `CurveSell` bonding-curve events (Pons v2 on Robinhood Chain, or any curve that emits the same events).
   - `transfer-flow`: a fallback for any venue. ERC-20 `Transfer` events in and out of a market address are read as buys and sells.
   Pons is one adapter among these, not a requirement.
3. **Native ETH.** Routers wrap ETH into WETH before it reaches a V2 or V3 pool and unwrap it on the way out. V4 pools can hold native ETH directly as currency `0x0`. Markets quoted in WETH (known addresses, the preset WETH, or a `symbol()` of `WETH`) or in `0x0` are marked as native, and the report gives their volume in ETH (`stats.nativeVolumeWei`).
4. **Trader attribution.** Routers and aggregators (Uniswap Universal Router, SwapRouter02, 1inch, 0x, Odos, KyberSwap, ParaSwap and others) show up as the event sender, so each trade goes to the wallet that signed the transaction (`tx.from`). For ERC-4337 bundles, or with `--force-flow`, the detector follows the token's `Transfer` hops inside the transaction to the end wallet. The router is still recorded as `via`, and `stats.entryPoints` counts trades per entry point. Unknown routers work the same way. `--router addr=label` only adds a label.
5. **Wallet evidence.** For the most active wallets it looks for native-token funding just before the first trade and the sweep right after the last trade. It does this by scanning full blocks in a short time window, so no archive node or indexer is needed. It also reads the token's `Approval` logs.
6. **Clustering.** Wallets are grouped by common funder. Wallets without funding data are grouped by repeated co-trading in the same short bursts.
7. **Scoring.** Each cluster gets 0 to 100 points from these signals:

| Signal | Points |
| --- | --- |
| Common funder sent equal amounts to the wallets | 20 (10 if the amounts differ) |
| Repeating burst shape, for example 2 buys + 1 sell or 5 buys + 2 sells | 15 |
| Seller rotates across the wallets | 10 |
| Regular gaps between bursts (low coefficient of variation) | 10 |
| Brand-new wallets (first trade at nonce 0 to 2) | 10 |
| Leftover ETH swept back to the funder | 10 |
| Volume recycled (net flow small compared with gross volume) | 10 |
| Max approval right before each wallet's first sell | 5 |
| Wallets end flat (sold everything they bought) | 5 |
| Cluster is half or more of the token's trades | 5 |

A token's score is its highest cluster score. 60 or more is `likely-bump`, 40 to 59 is `suspicious`, and anything lower is `low`. Every flag comes with its evidence: the wallet list, the funder, funding and sweep transaction hashes, approvals, and the burst-by-burst cycle pattern.

A high score means a trading pattern matches automated self-trading. It is not proof of intent or of who runs the wallets, so treat it as a signal to review.

## Install

Requires Node.js 23.6 or newer (TypeScript runs directly).

```
npm install
npm test
```

## Usage

```
# one-shot scan of a token, auto venue discovery on a preset chain
node src/cli.ts scan --chain base --token 0xYourToken --lookback 50000

# any EVM chain via RPC, nothing else: pools are found from the token's Transfer logs
node src/cli.ts scan --rpc https://your-rpc --token 0xToken --from-block 123456 --json report.json

# explicit pool
node src/cli.ts scan --rpc https://your-rpc --token 0xToken --pool 0xPair --skip-pool-scan

# Pons bonding curve on Robinhood Chain
node src/cli.ts scan --chain robinhood --token 0xToken --from-block 100745000

# follow new blocks and re-score in real time
node src/cli.ts watch --chain robinhood --token 0xToken --interval 3 --out alerts.jsonl

# scan every token launched on a factory in a block range
node src/cli.ts launchpad --chain robinhood --lookback 200000 --min-trades 12 --quiet          # Pons
node src/cli.ts launchpad --chain base --kind v2 --lookback 20000 --min-trades 12 --quiet       # any V2 fork (PairCreated)
node src/cli.ts launchpad --rpc https://your-rpc --kind v3 --factory 0xFactory --quote 0xWETH  # any V3 fork (PoolCreated)
```

Main options (run with `--help` for all of them):

- `--venue auto` (default) or a comma list of adapters.
- `--pool` for explicit pairs, pools, curves or market addresses. Unknown pools fall back to `transfer-flow`.
- `--skip-pool-scan` turns off factory-free pool discovery.
- `--kind pons|v2|v3` picks the launch event for `launchpad`. For `v2` and `v3` the launched token is the side that is not a `--quote` asset.
- `--quote` for the quote assets used in pool discovery. The default is the preset WETH plus native ETH.
- `--window-sec` sets the funding and sweep scan window (default 45 seconds).
- `--threshold` sets the flag threshold (default 60).
- `--burst-gap` sets the max seconds between trades in one burst (default 3).

Chain presets: `robinhood`, `robinhood-testnet`, `ethereum`, `base`, `arbitrum`. Any other chain works with `--rpc` and explicit pools.

## Output

The JSON report has, per token: `score`, `verdict`, `markets` (with how each was discovered and whether it is native-quoted), trade stats (trades, buys, sells, distinct wallets, distinct-wallet ratio, quote volume, native ETH volume, trades per entry point, flagged share), and `clusters[]`. Each cluster has its `score`, `reasons`, `features` (burst shape, seller rotation, gap mean and cv, funding spread, fresh share, net flow ratio and more), and `evidence` (funding, sweep and approval transactions, trade transactions, cycle pattern). `flaggedWallets` and `flaggedTxs` list everything in flagged clusters.

## Live testnet run (Robinhood Chain testnet, 11 Nov 2026)

We ran a synthetic bump bot (our private lab engine) on Robinhood Chain testnet (chain id 46630) against our own allowlist-gated test token, and pointed the detector at it live. Only the engine's own wallets can hold the token, so there was no other traffic on the pool.

- Token BLAB: [0x136dcd5ba1fbfdf0e2b7e629a6d22ba43eca4ec5](https://explorer.testnet.chain.robinhood.com/address/0x136dcd5ba1fbfdf0e2b7e629a6d22ba43eca4ec5), V2-style pair BLAB/WETH: [0xFF743bc5d53e308b26A4bE2804A28f0374690C46](https://explorer.testnet.chain.robinhood.com/address/0xFF743bc5d53e308b26A4bE2804A28f0374690C46).
- Entry points: a Router02-style router ([0xec7c...56fe](https://explorer.testnet.chain.robinhood.com/address/0xec7c27b7f75a30e616ca44daeec9eee1ac8556fe)) and a Universal Router style `execute` router ([0x986c...9cbc](https://explorer.testnet.chain.robinhood.com/address/0x986cc8c3a07a930dffa1f65dd0d6969788e79cbc), same `execute` selector and command ids as Uniswap's). Each trade picked one at random. Native ETH was wrapped to WETH by the routers.
- Engine pattern: 5 fresh wallets funded with 0.0012 ETH each by one funder, cycles of 5 buys and 2 rotating sells every 10 s (plus or minus 20%), max approval before each wallet's first sell, sell-all and sweep back to the funder at the end. 29 cycles in 300 s: 145 buys, 58 sells, 5 sell-alls (208 trades: 119 through the V2 router, 89 through the Universal Router style router).
- Example txs: [funding](https://explorer.testnet.chain.robinhood.com/tx/0x63aeead3e3bbddf6c7413dc2c95a8003d4f04a0bbe054a3ef738812feb5d16d3), [buy via V2 router](https://explorer.testnet.chain.robinhood.com/tx/0x937d51d5b4cc3350be5d521d058d55d68490db368990f5dac22052c049669ce8), [buy via Universal Router style](https://explorer.testnet.chain.robinhood.com/tx/0x3b53f0252866f2fa361986b32de3f63d2e90902479166949752c928f703850c7), [max approval](https://explorer.testnet.chain.robinhood.com/tx/0xf47e49a61cfb5caf643557e4ab253601f73bb5c62a302cc47dc55e3bb11e3e1d), [sell via Universal Router style](https://explorer.testnet.chain.robinhood.com/tx/0xa6de2dee298f76d7fdc07364c5256370112c21c3b4bf8f10546bb6917452709e), [sell-all](https://explorer.testnet.chain.robinhood.com/tx/0x5a9b1cb85dc7fc62284f4e3b5cb57efa63496d1781cd04ee23f2efd3fc46148a), [sweep](https://explorer.testnet.chain.robinhood.com/tx/0x188f653ca50ffbc2098a502e5f1919aa3b2852043ab5c409cccd6847c74587e3).

The detector was started with only `--rpc` and `--token` (no preset, no pool, no factory). Pool scan found the pair on its own from the token's `Transfer` logs. A second watcher with the pair passed explicitly gave the same final result.

| Measure (scored against the engine's labels) | Watch, auto discovery | Watch, explicit pool | One-shot scan after the run |
| --- | --- | --- | --- |
| First `likely-bump` flag | 46.9 s after session start (22 trades seen) | 48.6 s (26 trades seen) | n/a |
| Final score | 75 | 75 | 75 |
| Wallets flagged (precision / recall) | 5 of 5 (1.0 / 1.0) | 5 of 5 (1.0 / 1.0) | 5 of 5 (1.0 / 1.0) |
| Trades flagged (precision / recall) | 208 of 208 (1.0 / 1.0) | 208 of 208 (1.0 / 1.0) | 208 of 208 (1.0 / 1.0) |
| False positives | 0 | 0 | 0 |
| Evidence txs attached (funding, approvals, sweeps) | 20 | 20 | 20 |

Every trade was credited to the signing wallet even though the pool saw a router as the `Swap` sender, for both router types. Precision is easy here because nothing else traded the gated token, so this run measures recall and attribution, not false positives on organic traffic.

Signals that fired: common funder with equal amounts, seller rotation over all 5 wallets, fresh wallets, max approval before each first sell, wallets end flat, sweeps back to the funder, recycled volume (net flow 0.2% of gross), and the cluster being 100% of the tape. The burst-shape and regular-gap signals (25 points) did not fire. On testnet the engine waits for each confirmation, so a cycle's sells landed 3 to 10 s after its buys and the next cycle started 1 to 5 s later. With the default 3 s burst gap the 29 cycles were cut into 19 uneven bursts (5B/2S was the top shape at 37%). In an earlier local anvil rehearsal (V2 router only, tighter timing) the same engine scored 100. Segmenting bursts relative to the cluster's own cadence, instead of a fixed gap, is the next improvement.

## Worked example

`test/fixtures/mentatbot-pons-4663.json` holds the public on-chain trades of the MentatBot (MNT) token on Pons, Robinhood Chain, from the public demo of a Telegram bump tool. The detector scores it 100 (`likely-bump`). It finds 3 fresh wallets funded with identical amounts by one address, 14 bursts of 2 buys + 1 rotating sell about every 10 seconds, max approvals before each wallet's first sell, a final sell-all, and sweeps back to the funder. The cluster is 98% of the token's trades.

## Limits

- Funding through internal calls (contract wallets, CEX batch payouts in one contract call) is not seen by the block scan. The pattern signals still work without it.
- One submitter that trades for many recipients collapses into one trader under `tx.from` attribution. Use `--force-flow` to attribute by token flow instead.
- Busy organic tokens can produce long bursts. Bursts with many trades are ignored for co-trading edges.
- Public RPCs rate limit. Large ranges are fetched in chunks and retried.

## License

MIT
