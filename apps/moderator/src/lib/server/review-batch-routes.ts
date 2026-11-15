import { error, json, type RequestHandler } from '@sveltejs/kit';
import { REVIEW_SERVED_ACTIVITY, type ReviewTier } from '@civitai/shared/review-batch';
import { canAccess } from './access';
import { logToAxiom } from './axiom';
import { SERVED_ACTIVITY } from '@civitai/shared/held-media';
import { streamStoredMedia } from './held-media-stream';
import { SHEET_COOKIE, sheetCookie } from './held-sheet';
import { insertModActivity } from './mod-activity';
import {
  getBatchMedia,
  getReviewBatch,
  type LoadedBatch,
  mintingKeyLive,
  scannerHoldsImage,
  TIER_PAGE,
} from './review-batch';

export const ROUTING_MISS_EVENT = 'review-batch-routing-miss';

const noStore = { 'cache-control': 'no-store' };

/** The batch this request may open: live, of this route's tier, minted for this moderator, its key
 *  live, who still holds the tier's page grant, and in this sheet session. A general session joins
 *  such a batch on first open (one sign-in a day); a held one never does. Anything else answers 404. */
async function authorizedBatch(
  locals: App.Locals,
  tier: ReviewTier,
  batchId: string | undefined
): Promise<{ batch: LoadedBatch; user: NonNullable<App.Locals['user']> }> {
  const user = locals.user;
  const sheet = locals.reviewSheet;
  if (!user || !sheet || sheet.tier !== tier) error(403, 'Not signed in to this sheet.');
  if (!canAccess(user, TIER_PAGE[tier])) error(403, 'You do not have access to this page.');
  const batch = await getReviewBatch(batchId).catch(() => undefined);
  if (batch === undefined) error(503, 'Could not read the batch.');
  if (!batch || batch.tier !== tier || batch.viewer !== user.id) error(404, 'Not available here.');
  if (!(await mintingKeyLive(batch.keyId))) error(404, 'Not available here.');
  if (!sheet.batches.includes(batch.hash)) {
    const joined = tier === 'general' && sheet.join ? await sheet.join(batch.hash) : false;
    if (!joined) error(404, 'Not available here.');
  }
  return { batch, user };
}

export function batchCountHandler(tier: ReviewTier): RequestHandler {
  return async ({ locals, params }) => {
    const { batch } = await authorizedBatch(locals, tier, params.batchId);
    return json({ count: batch.ids.length }, { headers: noStore });
  };
}

export function batchItemHandler(tier: ReviewTier): RequestHandler {
  return async ({ locals, params, request, cookies }) => {
    const { batch, user } = await authorizedBatch(locals, tier, params.batchId);
    const n = Number(params.n);
    if (!/^\d{1,3}$/.test(params.n ?? '') || n >= batch.ids.length)
      error(404, 'Not available here.');

    const media = await getBatchMedia(batch, n);
    if (!media) error(404, 'Not available here.');
    const review = { batchHash: batch.hash, tier, declared: batch.declared };

    if (tier === 'held') {
      const token = cookies.get(SHEET_COOKIE);
      return streamStoredMedia({
        media,
        imageId: media.imageId,
        moderatorId: user.id,
        sheet: true,
        request,
        audit: () =>
          insertModActivity({
            userId: user.id,
            entityType: 'image',
            entityId: media.imageId,
            activity: SERVED_ACTIVITY,
            credential: 'sheet',
            review,
          }),
        setCookie: token ? sheetCookie(token) : undefined,
      });
    }

    // The mint read the scanner rows; a label written since then must still stop the bytes.
    if (media.held || (await scannerHoldsImage(media.imageId))) {
      void logToAxiom({
        name: ROUTING_MISS_EVENT,
        type: 'warning',
        stage: 'fetch',
        batchHash: batch.hash,
        index: n,
      }).catch(() => null);
      return json({ moved: true }, { status: 409, headers: noStore });
    }
    return streamStoredMedia({
      media,
      imageId: media.imageId,
      moderatorId: user.id,
      sheet: true,
      request,
      audit: () =>
        insertModActivity({
          userId: user.id,
          entityType: 'image',
          entityId: media.imageId,
          activity: REVIEW_SERVED_ACTIVITY,
          credential: 'sheet',
          review,
        }),
    });
  };
}
