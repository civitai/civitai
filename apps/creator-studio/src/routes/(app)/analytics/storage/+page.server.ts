import type { PageServerLoad } from './$types';
import { getStorageByModel, loadStorageUsage } from '$lib/server/storage';
import { summarizeStorage } from '$lib/analytics/storage';
import { readTableSort } from '$lib/server/table-sort';

export const load: PageServerLoad = async ({ locals, cookies }) => {
  const userId = locals.user.id;
  const [usage, byModel] = await Promise.all([
    loadStorageUsage(userId).catch(() => null),
    getStorageByModel({ userId }).catch(() => null),
  ]);

  return {
    // null = the read failed; ready false = the tables do not exist yet.
    ready: usage?.ready ?? null,
    summary: usage?.ready ? summarizeStorage(usage.rows) : null,
    media: usage?.media ?? null,
    byModel,
    tableSort: readTableSort(cookies, 'storage'),
  };
};
