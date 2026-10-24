import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getComicViewDetail } from '$lib/server/analytics-detail';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, params, cookies }) => {
  const projectId = Number(params.projectId);
  if (!Number.isInteger(projectId) || projectId <= 0) throw error(400, 'Invalid id');
  const { range, compare: baseline } = readAnalyticsPeriod(cookies);
  const compare = baseline.range;

  // Ownership is enforced inside the read; a miss is indistinguishable from a deleted entity by design.
  const detail = await getComicViewDetail({
    userId: locals.user.id,
    projectId,
    ...range,
    compareFrom: compare.from,
    compareTo: compare.to,
  });
  if (!detail) throw error(404, 'Not found, or not yours');
  return { detail };
};
