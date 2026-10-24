import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam } from '$lib/server/api-guard';
import { getReactions, type ReactionCursor } from '$lib/server/image-reactions.service';

/**
 * The rest of an image's reaction list, past the first page the page load carries.
 *
 * The ticket this closes asked that a moderator be able to pull "the true set, not a truncated
 * sample" — so the list has to be exhaustible. It stays off the page load because a popular image
 * carries thousands of rows and almost every lookup only needs the first screen.
 *
 * The cursor is the previous page's last row, not a row offset — see `getReactions` for why that is a
 * correctness property here rather than a performance one.
 */
const MAX_PAGE = 1_000;

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const imageId = requireIdParam(locals, params.imageId, '/retool/image-lookup', 'imageId');

  // Clamped rather than rejected: this comes from the page's own "load all" button, and a 400 there
  // renders as a dead control with nothing to say why.
  const limit = Math.min(
    MAX_PAGE,
    Math.max(1, Math.trunc(Number(url.searchParams.get('limit')) || 100))
  );

  // 🔴 BOTH HALVES OR NEITHER. A cursor with a valid time and a junk id would resume from
  // `(time, NaN)`, and every row comparison against NaN is false — so the query returns nothing and
  // the caller reads an empty page as the end of the list. Rejecting the pair together makes a
  // malformed cursor behave as no cursor: the walk restarts, which is visibly wrong rather than
  // quietly short.
  const rawTime = url.searchParams.get('beforeCreatedAt');
  const rawId = Number(url.searchParams.get('beforeId'));
  const time = rawTime ? new Date(rawTime) : null;
  const cursor: ReactionCursor | null =
    time && !Number.isNaN(time.getTime()) && Number.isInteger(rawId) && rawId > 0
      ? { createdAt: time, id: rawId }
      : null;

  return json(await getReactions(imageId, { limit, cursor }));
};
