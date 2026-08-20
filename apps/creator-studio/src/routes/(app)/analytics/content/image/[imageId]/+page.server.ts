import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getImageViewDetail } from '$lib/server/analytics';
import { readAnalyticsPeriod } from '$lib/server/analytics-period';

export const load: PageServerLoad = async ({ locals, params, cookies }) => {
  const imageId = Number(params.imageId);
  if (!Number.isInteger(imageId) || imageId <= 0) throw error(400, 'Invalid image id');
  const { range, compare: baseline } = readAnalyticsPeriod(cookies);
  const compare = baseline.range;

  // Ownership is enforced inside the read, which returns null for an image that isn't the caller's — same
  // shape as a deleted one, so the 404 doesn't tell a prober which of the two they hit.
  const [image, compareDetail] = await Promise.all([
    getImageViewDetail({
      userId: locals.user.id,
      imageId,
      ...range,
      compareFrom: compare.from,
      compareTo: compare.to,
    }),
    getImageViewDetail({
      userId: locals.user.id,
      imageId,
      ...compare,
      compareFrom: compare.from,
      compareTo: compare.to,
    }).catch(() => null),
  ]);
  if (!image) throw error(404, 'Image not found, or not yours');

  return { image, compareSeries: compareDetail?.series ?? [] };
};
