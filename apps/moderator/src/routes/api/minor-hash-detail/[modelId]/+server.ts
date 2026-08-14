import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import {
  getAutoFlaggedMinorDetail,
  getMinorHashMatchDetail,
} from '$lib/server/minor-hash.service';
import { MINOR_HASH_PATH } from '../../../models/minor-hash-matches/tabs';

// Per-row on expand, not joined into the list: covers, uploader counts and flag provenance are
// per-model lookups that would turn a 50-row page into 50x the work for detail most rows never show.
// `/api/*` is exempt from the global route gate, so this checks the page's own path itself.
export const GET: RequestHandler = async ({ params, url, locals }) => {
  if (!locals.user || !canAccess(locals.user, MINOR_HASH_PATH))
    return json({ error: 'No access.' }, { status: 403 });

  const modelId = Number(params.modelId);
  if (!modelId) return json({ error: 'Bad model id.' }, { status: 400 });

  // The Pending tab already knows which seed matched, so it passes it and skips re-deriving. The
  // other two tabs have no pointer to the seed and must resolve it from the hash.
  const minorModelId = Number(url.searchParams.get('minorModelId')) || null;
  if (minorModelId) return json({ match: null, detail: await getMinorHashMatchDetail({ modelId, minorModelId }) });
  return json(await getAutoFlaggedMinorDetail({ modelId }));
};
