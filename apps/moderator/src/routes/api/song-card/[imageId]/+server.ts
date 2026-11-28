import { error, isHttpError, json, type RequestHandler } from '@sveltejs/kit';
import { RETRACTED_REFUSED } from '$lib/held-media';
import { withheldImageIds } from '$lib/server/retracted-media';
import { getSongCard } from '$lib/server/song-card.service';

const MAX_INT = 2_147_483_647;
const NO_STORE = { 'cache-control': 'private, no-store' };

/**
 * A song card's title, length, lyrics and cover, for a moderator. A song withheld from this moderator
 * (CSAM-restricted, without the CSAM page's grant) is refused like its media: the grid shows no card
 * for it, and its lyrics are not served either.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  try {
    if (!locals.user) error(403, 'Not signed in.');
    const imageId = Number(params.imageId);
    if (!Number.isInteger(imageId) || imageId <= 0 || imageId > MAX_INT)
      error(400, 'Bad image id.');
    const withheld = await withheldImageIds(locals.user, [imageId]).catch(() => {
      error(503, 'Could not check this song; retry.');
    });
    if (withheld.length) error(404, RETRACTED_REFUSED);
    const card = await getSongCard(imageId);
    if (!card) error(404, 'Not a song.');
    return json(card, { headers: NO_STORE });
  } catch (e) {
    if (!isHttpError(e)) throw e;
    return json(e.body, { status: e.status, headers: NO_STORE });
  }
};
