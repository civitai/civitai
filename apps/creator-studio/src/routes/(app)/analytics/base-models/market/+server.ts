import { error, json, type RequestHandler } from '@sveltejs/kit';
import { marketView, parseMarketFilters } from '$lib/analytics/market-overview';
import { getMarketSnapshot, marketOverviewEnabled } from '$lib/server/market-overview';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!(await marketOverviewEnabled(locals.user))) throw error(404, 'Not found');
  const snapshot = await getMarketSnapshot();
  if (!snapshot) throw error(503, 'The market overview is unavailable right now.');
  return json(marketView(snapshot, parseMarketFilters(url.searchParams)), {
    headers: { 'cache-control': 'private, no-store' },
  });
};
