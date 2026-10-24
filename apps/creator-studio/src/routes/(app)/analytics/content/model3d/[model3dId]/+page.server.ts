import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getModel3dViewDetail } from '$lib/server/analytics-detail';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, params, cookies }) => {
  const model3dId = Number(params.model3dId);
  if (!Number.isInteger(model3dId) || model3dId <= 0) throw error(400, 'Invalid id');
  const { range, compare: baseline } = readAnalyticsPeriod(cookies);
  const compare = baseline.range;

  // Ownership is enforced inside the read; a miss is indistinguishable from a deleted entity by design.
  const detail = await getModel3dViewDetail({
    userId: locals.user.id,
    model3dId,
    ...range,
    compareFrom: compare.from,
    compareTo: compare.to,
  });
  if (!detail) throw error(404, 'Not found, or not yours');
  return { detail };
};
