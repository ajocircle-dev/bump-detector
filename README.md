# bump-detector

Read-only detector for fake volume on EVM tokens. It flags "bump bot" and wash-trading activity, where a small group of wallets controlled by one operator trades a token back and forth so the chart and the trade count look busy.

It is meant for:

- **Launchpads**, to label or delist tokens whose early volume is mostly self-trading.
- **Traders and tools**, to check whether a busy new chart is real before buying.
- **Researchers**, to measure how much of a venue's volume is recycled.

It only reads public chain data through a normal JSON-RPC endpoint. It never signs or sends transactions.

## How it works

1. **Venue adapters** turn swap events into trades. Built in:
   - `uniswap-v2`: `Swap` on V2 style pairs (Uniswap V2 and forks).
   - `uniswap-v3`: `Swap` on V3 pools.
   - `uniswap-v4`: `Swap` on the V4 PoolManager, keyed by pool id (native ETH pools included).
   - `pons`: `CurveBuy` / `CurveSell` bonding-curve events (Pons v2 on Robinhood Chain, or any curve that emits the same events).
   - `transfer-flow`: a fallback for any venue. ERC-20 `Transfer` events in and out of a market address are read as buys and sells.
2. **Trader attribution.** Routers and aggregators (Uniswap Universal Router, SwapRouter02, 1inch, 0x, Odos, KyberSwap, ParaSwap and others) show up as the event sender, so each trade goes to the wallet that signed the transaction (`tx.from`). For ERC-4337 bundles, or with `--force-flow`, the detector follows the token's `Transfer` hops inside the transaction to the end wallet. The router is still recorded as `via` for context.
3. **Wallet evidence.** For the most active wallets it looks for native-token funding just before the first trade and the sweep right after the last trade. It does this by scanning full blocks in a short time window, so no archive node or indexer is needed. It also reads the token's `Approval` logs.
4. **Clustering.** Wallets are grouped by common funder. Wallets without funding data are grouped by repeated co-trading in the same short bursts.
5. **Scoring.** Each cluster gets 0 to 100 points from these signals:

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

# any EVM chain via RPC, explicit pool, JSON report
node src/cli.ts scan --rpc https://your-rpc --token 0xToken --pool 0xPair --json report.json

# Pons bonding curve on Robinhood Chain
node src/cli.ts scan --chain robinhood --token 0xToken --from-block 100745000

# follow new blocks and re-score in real time
node src/cli.ts watch --chain robinhood --token 0xToken --interval 3 --out alerts.jsonl

# scan every token launched on a launchpad factory in a block range
node src/cli.ts launchpad --chain robinhood --lookback 200000 --min-trades 12 --quiet
```

Main options (run with `--help` for all of them):

- `--venue auto` (default) or a comma list of adapters.
- `--pool` for explicit pairs, pools, curves or market addresses. Unknown pools fall back to `transfer-flow`.
- `--quote` for the quote assets used in pool discovery. The default is the preset WETH plus native ETH.
- `--window-sec` sets the funding and sweep scan window (default 45 seconds).
- `--threshold` sets the flag threshold (default 60).
- `--burst-gap` sets the max seconds between trades in one burst (default 3).

Chain presets: `robinhood`, `robinhood-testnet`, `ethereum`, `base`, `arbitrum`. Any other chain works with `--rpc` and explicit pools.

## Output

The JSON report has, per token: `score`, `verdict`, trade stats (trades, buys, sells, distinct wallets, distinct-wallet ratio, quote volume, flagged share), and `clusters[]`. Each cluster has its `score`, `reasons`, `features` (burst shape, seller rotation, gap mean and cv, funding spread, fresh share, net flow ratio and more), and `evidence` (funding, sweep and approval transactions, trade transactions, cycle pattern). `flaggedWallets` and `flaggedTxs` list everything in flagged clusters.

## Worked example

`test/fixtures/mentatbot-pons-4663.json` holds the public on-chain trades of the MentatBot (MNT) token on Pons, Robinhood Chain, from the public demo of a Telegram bump tool. The detector scores it 100 (`likely-bump`). It finds 3 fresh wallets funded with identical amounts by one address, 14 bursts of 2 buys + 1 rotating sell about every 10 seconds, max approvals before each wallet's first sell, a final sell-all, and sweeps back to the funder. The cluster is 98% of the token's trades.

## Limits

- Funding through internal calls (contract wallets, CEX batch payouts in one contract call) is not seen by the block scan. The pattern signals still work without it.
- One submitter that trades for many recipients collapses into one trader under `tx.from` attribution. Use `--force-flow` to attribute by token flow instead.
- Busy organic tokens can produce long bursts. Bursts with many trades are ignored for co-trading edges.
- Public RPCs rate limit. Large ranges are fetched in chunks and retried.

## License

MIT
