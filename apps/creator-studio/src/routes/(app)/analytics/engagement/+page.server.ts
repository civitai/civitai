import type { PageServerLoad } from './$types';
import { safeError } from '@civitai/axiom';
import { readTableSort } from '$lib/server/table-sort';
import { getHotRanks, getModelEngagement, hotRankAsOf } from '$lib/server/engagement';
import { getLogger } from '$lib/server/logger';
import { withTimeoutFallback } from '$lib/server/timeout';

// The rank column must never hold up or take down the engagement list: ClickHouse can stall for minutes.
const HOT_RANK_TIMEOUT_MS = 3000;

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const userId = locals.user.id;
  const [engagement, hotRanks] = await Promise.all([
    getModelEngagement({ userId }).catch(() => null),
    withTimeoutFallback(
      getHotRanks({ userId }).catch((error) => {
        getLogger().logToAxiom({
          name: 'engagement-hot-rank-unavailable',
          error: safeError(error),
        });
        return null;
      }),
      HOT_RANK_TIMEOUT_MS,
      null
    ),
  ]);
  return {
    engagement,
    // null = the read failed or timed out; { day: null } = no snapshot day is complete yet.
    hotRanks,
    hotRankAsOf: hotRankAsOf(hotRanks?.day ?? null),
    tableSort: readTableSort(cookies, 'engagement'),
  };
};
