import type { Address, Hex } from "viem";

export type Side = "buy" | "sell";

/// A place where the token trades: a V2 pair, a V3 pool, a V4 pool id, a bonding
/// curve, or a plain address for the Transfer-flow fallback.
export interface Market {
  venue: string;
  address: Address; // pair / pool / curve / PoolManager for v4
  token: Address;
  quote: Address | null; // null when unknown (transfer-flow)
  tokenIndex?: 0 | 1; // for v2/v3/v4: is the token currency0 or currency1
  poolId?: Hex; // v4 only
  fee?: number;
}

/// A trade as decoded from a venue event, before trader attribution.
export interface RawTrade {
  venue: string;
  market: Address;
  token: Address;
  side: Side;
  tokenAmount: bigint;
  quoteAmount: bigint | null;
  block: number;
  logIndex: number;
  txIndex: number;
  tx: Hex;
  eventSender?: Address;
  eventRecipient?: Address;
}

export interface Trade extends RawTrade {
  trader: Address;
  attribution: "tx.from" | "transfer-flow" | "event";
  via: Address | null; // tx.to (router / aggregator / curve)
  viaLabel: string | null;
  txNonce: number | null;
  timestamp: number;
}

export interface Funding {
  funder: Address;
  amount: bigint;
  tx: Hex;
  block: number;
  timestamp?: number;
}

export interface Sweep {
  to: Address;
  amount: bigint;
  tx: Hex;
  block: number;
}

export interface Approval {
  spender: Address;
  value: bigint;
  block: number;
  logIndex: number;
  tx: Hex;
}

export interface WalletInfo {
  address: Address;
  firstNonce: number | null; // nonce of the wallet's first observed trade tx
  funding: Funding | null;
  sweep: Sweep | null;
  approvals: Approval[];
}

export interface ClusterReport {
  id: string;
  basis: "common-funder" | "co-trading";
  score: number;
  verdict: Verdict;
  wallets: Address[];
  funder: Address | null;
  reasons: string[];
  features: Record<string, unknown>;
  evidence: {
    fundingTxs: { wallet: Address; tx: Hex; amount: string; block: number }[];
    sweepTxs: { wallet: Address; to: Address; tx: Hex; amount: string; block: number }[];
    approveTxs: { wallet: Address; spender: Address; tx: Hex; block: number }[];
    tradeTxs: Hex[];
    cyclePattern: string[]; // e.g. ["2B/1S seller=0xabc..", ...]
  };
}

export type Verdict = "likely-bump" | "suspicious" | "low";

export interface TokenReport {
  chainId: number;
  token: Address;
  markets: Market[];
  fromBlock: number;
  toBlock: number;
  generatedAt: string;
  score: number;
  verdict: Verdict;
  stats: {
    trades: number;
    buys: number;
    sells: number;
    distinctTraders: number;
    distinctWalletRatio: number;
    quoteVolume: string | null;
    flaggedTradeShare: number;
  };
  clusters: ClusterReport[];
  flaggedWallets: Address[];
  flaggedTxs: Hex[];
  notes: string[];
}
