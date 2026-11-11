import { createPublicClient, http, type Address, type Hex, type Log, type PublicClient, type Transaction } from "viem";

export interface Rpc {
  client: PublicClient;
  chainId: number;
  getLogs(p: { address?: Address | Address[]; topics: (Hex | Hex[] | null)[]; fromBlock: number; toBlock: number }): Promise<Log[]>;
  blockTime(n: number): Promise<number>;
  tx(h: Hex): Promise<Transaction>;
  block(n: number): Promise<{ timestamp: number; transactions: Transaction[] }>;
  head(): Promise<number>;
}

export async function pMap<T, R>(items: T[], f: (t: T, i: number) => Promise<R>, conc = 8): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await f(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return out;
}

export async function makeRpc(url: string, opts: { maxRange?: number } = {}): Promise<Rpc> {
  const client = createPublicClient({ transport: http(url, { retryCount: 4, retryDelay: 300, batch: false }) }) as PublicClient;
  const chainId = await client.getChainId();
  const maxRange = opts.maxRange ?? 500_000;
  const tsCache = new Map<number, number>();
  const txCache = new Map<string, Transaction>();
  const blockCache = new Map<number, { timestamp: number; transactions: Transaction[] }>();

  const rawLogs = async (address: Address | Address[] | undefined, topics: (Hex | Hex[] | null)[], from: number, to: number): Promise<Log[]> => {
    return (await client.request({
      method: "eth_getLogs",
      params: [{ address, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` } as never],
    })) as unknown as Log[];
  };

  const getLogs: Rpc["getLogs"] = async ({ address, topics, fromBlock, toBlock }) => {
    const out: Log[] = [];
    let from = fromBlock;
    let span = maxRange;
    while (from <= toBlock) {
      const to = Math.min(toBlock, from + span - 1);
      try {
        out.push(...(await rawLogs(address, topics, from, to)));
        from = to + 1;
      } catch (e) {
        if (span <= 100) throw e;
        span = Math.floor(span / 4);
      }
    }
    return out.map((l) => ({
      ...l,
      blockNumber: BigInt(l.blockNumber as unknown as string),
      logIndex: Number(l.logIndex as unknown as string),
      transactionIndex: Number(l.transactionIndex as unknown as string),
    })) as Log[];
  };

  const block: Rpc["block"] = async (n) => {
    const c = blockCache.get(n);
    if (c) return c;
    const b = await client.getBlock({ blockNumber: BigInt(n), includeTransactions: true });
    const v = { timestamp: Number(b.timestamp), transactions: b.transactions as Transaction[] };
    blockCache.set(n, v);
    tsCache.set(n, v.timestamp);
    if (blockCache.size > 5000) blockCache.delete(blockCache.keys().next().value!);
    return v;
  };

  return {
    client,
    chainId,
    getLogs,
    async blockTime(n) {
      const c = tsCache.get(n);
      if (c !== undefined) return c;
      const b = await client.getBlock({ blockNumber: BigInt(n) });
      tsCache.set(n, Number(b.timestamp));
      return Number(b.timestamp);
    },
    async tx(h) {
      const c = txCache.get(h);
      if (c) return c;
      const t = await client.getTransaction({ hash: h });
      txCache.set(h, t);
      return t;
    },
    block,
    async head() {
      return Number(await client.getBlockNumber());
    },
  };
}
