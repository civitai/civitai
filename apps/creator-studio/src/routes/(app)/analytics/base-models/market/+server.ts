import {
  getMarketSnapshot,
  marketHandler,
  marketOverviewEnabled,
} from '$lib/server/market-overview';

export const GET = marketHandler(marketOverviewEnabled, getMarketSnapshot);
