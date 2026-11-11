// Chain presets. All optional: any EVM chain works with --rpc plus explicit markets.
// Addresses are public deployments; the detector only reads.
import type { Address } from "viem";

export interface ChainPreset {
  id: number;
  name: string;
  rpc: string;
  weth?: Address;
  uniswapV2Factories?: Address[];
  uniswapV3Factories?: Address[];
  uniswapV4PoolManager?: Address;
  ponsFactories?: Address[];
  routers?: Record<string, string>; // address (lowercase) -> label
}

export const ENTRYPOINTS: Record<string, string> = {
  "0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789": "ERC-4337 EntryPoint v0.6",
  "0x0000000071727de22e5e9d8baf0edac6f37da032": "ERC-4337 EntryPoint v0.7",
};

// Common routers and aggregators. Labels are informational: the detector always
// attributes the trade to the wallet that sent the tx (or to the transfer flow).
export const COMMON_ROUTERS: Record<string, string> = {
  "0x7a250d5630b4cf539739df2c5dacb4c659f2488d": "Uniswap V2 Router02",
  "0xe592427a0aece92de3edee1f18e0157c05861564": "Uniswap V3 SwapRouter",
  "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45": "Uniswap SwapRouter02",
  "0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad": "Uniswap Universal Router",
  "0x66a9893cc07d91d95644aedd05d03f95e1dba8af": "Uniswap Universal Router (v4)",
  "0x1111111254eeb25477b68fb85ed929f73a960582": "1inch v5 Router",
  "0x111111125421ca6dc452d289314280a0f8842a65": "1inch v6 Router",
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff": "0x Exchange Proxy",
  "0xcf5540fffcdc3d510b18bfca6d2b9987b0772559": "Odos Router v2",
  "0x0d05a7d3448512b78fa8a9e46c4872c88c4a0d05": "Odos Router v3",
  "0x6131b5fae19ea4f9d964eac0408e4408b66337b5": "KyberSwap MetaAggregationRouterV2",
  "0x6a000f20005980200259b80c5102003040001068": "ParaSwap Augustus v6",
  "0x000000000022d473030f116ddee9f6b43ac78ba3": "Permit2",
};

export const PRESETS: Record<string, ChainPreset> = {
  robinhood: {
    id: 4663,
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    uniswapV4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    ponsFactories: ["0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e"],
    routers: {
      "0x204faca1764b154221e35c0d20abb3c525710498": "Uniswap Universal Router 2.1.2",
      "0xe33e9e479df8802cb0866d5d05258bec4cf62948": "Pons launch-and-buy router",
    },
  },
  "robinhood-testnet": {
    id: 46630,
    name: "Robinhood Chain Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
  },
  ethereum: {
    id: 1,
    name: "Ethereum",
    rpc: "https://ethereum-rpc.publicnode.com",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    uniswapV2Factories: ["0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"],
    uniswapV3Factories: ["0x1F98431c8aD98523631AE4a59f267346ea31F984"],
    uniswapV4PoolManager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    routers: { "0x23617e59a5925b2a4bf75d73ff6711cd0b29de85": "Uniswap Universal Router 2.1.2" },
  },
  base: {
    id: 8453,
    name: "Base",
    rpc: "https://mainnet.base.org",
    weth: "0x4200000000000000000000000000000000000006",
    uniswapV2Factories: ["0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"],
    uniswapV3Factories: ["0x33128a8fC17869897dcE68Ed026d694621f6FDfD"],
    uniswapV4PoolManager: "0x498581fF718922c3f8e6A244956aF099B2652b2b",
    routers: { "0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40": "Uniswap Universal Router 2.1.2" },
  },
  arbitrum: {
    id: 42161,
    name: "Arbitrum One",
    rpc: "https://arb1.arbitrum.io/rpc",
    weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    uniswapV3Factories: ["0x1F98431c8aD98523631AE4a59f267346ea31F984"],
    uniswapV4PoolManager: "0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32",
    routers: { "0x2d01411773c8c24805306e89a41f7855c3c4fe65": "Uniswap Universal Router 2.1.2" },
  },
};

export function routerLabel(preset: ChainPreset | undefined, addr: string | null, extra: Record<string, string> = {}): string | null {
  if (!addr) return null;
  const a = addr.toLowerCase();
  return extra[a] ?? preset?.routers?.[a] ?? COMMON_ROUTERS[a] ?? ENTRYPOINTS[a] ?? null;
}
