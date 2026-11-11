import type { VenueAdapter } from "./common.ts";
import { uniswapV2 } from "./uniswapV2.ts";
import { uniswapV3 } from "./uniswapV3.ts";
import { uniswapV4 } from "./uniswapV4.ts";
import { pons } from "./pons.ts";
import { transferFlow } from "./transferFlow.ts";

export const ADAPTERS: Record<string, VenueAdapter> = {
  "uniswap-v2": uniswapV2,
  "uniswap-v3": uniswapV3,
  "uniswap-v4": uniswapV4,
  pons,
  "transfer-flow": transferFlow,
};
export type { VenueAdapter, DiscoverOpts } from "./common.ts";
