import type { PageServerLoad } from './$types';
import { getStorageByModel, getStorageUsage, requestMediaRollup } from '$lib/server/storage';
import { needsMediaRefresh, summarizeStorage } from '$lib/analytics/storage';
import { readTableSort } from '$lib/server/table-sort';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const userId = locals.user.id;
  const [usage, byModel] = await Promise.all([
    getStorageUsage(userId).catch(() => null),
    getStorageByModel({ userId }).catch(() => null),
  ]);

  // Never awaited: the image rollup runs in a main-app job, and this page only asks for it.
  const queued = !!usage?.ready && needsMediaRefresh(usage.state);
  if (queued) void requestMediaRollup(userId);

  return {
    ready: usage?.ready ?? true,
    summary: usage?.ready ? summarizeStorage(usage.rows) : null,
    state: usage?.state ?? null,
    queued,
    byModel,
    tableSort: readTableSort(cookies, 'storage'),
  };
};
