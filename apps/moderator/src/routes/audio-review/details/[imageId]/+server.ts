import { error, isHttpError, json, type RequestHandler } from '@sveltejs/kit';
import { RETRACTED_REFUSED } from '$lib/held-media';
import { getSongDetails } from '$lib/server/audio-review.service';
import { int4Id } from '$lib/server/query';
import { withheldImageIds } from '$lib/server/retracted-media';

const NO_STORE = { 'cache-control': 'private, no-store' };

/**
 * The open song's facts, scans, cover, generation and owner on Audio review. Under the page's own
 * path, so its page grant gates it. A song withheld from this moderator is refused like its media.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  try {
    if (!locals.user) error(403, 'Not signed in.');
    const id = int4Id.safeParse(params.imageId);
    if (!id.success) error(400, 'Bad image id.');
    const withheld = await withheldImageIds(locals.user, [id.data]).catch(() => {
      error(503, 'Could not check this song; retry.');
    });
    if (withheld.length) error(404, RETRACTED_REFUSED);
    const details = await getSongDetails(id.data, locals.user);
    if (!details) error(404, 'Not a song.');
    return json(details, { headers: NO_STORE });
  } catch (e) {
    if (!isHttpError(e)) throw e;
    return json(e.body, { status: e.status, headers: NO_STORE });
  }
};
