import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getModelVersionAnalytics, getModelVersionSeries } from '$lib/server/models-earnings';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, params, cookies }) => {
  const modelId = Number(params.modelId);
  if (!Number.isInteger(modelId) || modelId <= 0) throw error(400, 'Invalid model id');
  const { range, compare: baseline } = readAnalyticsPeriod(cookies);
  const compare = baseline.range;
  // Ownership is enforced inside the read (returns null for a model that isn't the caller's).
  const userId = locals.user.id;
  const [model, series, compareSeries] = await Promise.all([
    getModelVersionAnalytics({
      userId,
      modelId,
      ...range,
      compareFrom: compare.from,
      compareTo: compare.to,
    }),
    getModelVersionSeries({ userId, modelId, ...range }).catch(() => null),
    // Same per-version series for the comparison month — the chart overlays it as a dashed line per version.
    getModelVersionSeries({ userId, modelId, ...compare }).catch(() => null),
  ]);
  if (!model) throw error(404, 'Model not found, or not yours');
  return { model, series, compareSeries };
};
