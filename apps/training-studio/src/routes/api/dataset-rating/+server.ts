import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireToken } from '$lib/server/token';
import { orchestratorClient } from '$lib/server/orchestrator';
import { claimDaily, datasetRatingFor, warmDatasetRating } from '$lib/server/dataset-rating';
import { countDatasetMature } from '$lib/train-core';
import type { DatasetRatingCount } from '$lib/dataset-rating';

/** More blobs than any dataset the app builds; a bigger body is refused rather than rated. */
const MAX_BLOBS = 2000;

// Review's mature count under the v2 rating, the count the submit will make from what is rated now,
// and a background start on rating the rest so the submit finds them rated. Off for this user: `enabled`
// false, and Review counts from the upload rating as before.
export const POST: RequestHandler = async ({ locals, request }) => {
  const rating = await datasetRatingFor(locals.user);
  if (!rating) return json({ enabled: false } satisfies DatasetRatingCount);

  const body = (await request.json().catch(() => null)) as { blobIds?: unknown } | null;
  const blobIds = body?.blobIds;
  if (
    !Array.isArray(blobIds) ||
    blobIds.length > MAX_BLOBS ||
    !blobIds.every((id) => typeof id === 'string' && id.length > 0 && id.length < 512)
  )
    error(400, 'Bad dataset rating request.');

  // Off past today's allowance: Review keeps its own count, the submit still counts server-side.
  if ((await claimDaily('lookups', locals.user.id, 1)) === 0)
    return json({ enabled: false } satisfies DatasetRatingCount);
  const token = await requireToken(locals, 'Rating is unavailable right now.');
  const count = await countDatasetMature(orchestratorClient(token), blobIds as string[], rating);
  warmDatasetRating(token, locals.user.id, count.unratedKeys);
  // A blob this request could not read would count as not mature here, though Review's own upload count
  // knows its rating, so Review keeps that count.
  if (count.failed > 0) return json({ enabled: false } satisfies DatasetRatingCount);
  return json({
    enabled: true,
    matureCount: count.mature,
    unrated: count.images - count.rated,
  } satisfies DatasetRatingCount);
};
