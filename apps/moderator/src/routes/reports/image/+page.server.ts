import { fail, type RequestEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { imageQueueActions, loadImageQueue } from '$lib/server/image-queue';
import { stickerPlacementActions } from '$lib/server/sticker-placement-actions';

// Image reports, as the image queues' card grid rather than a report table: one card per Pending
// report, judged by looking at the image. Moved here from `/images/reported` (2026-10-15), replacing
// the `/reports/[slug]` table for images — one page per report type. The page and its actions are the
// image queues' (`$lib/server/image-queue.ts`, `$lib/components/image-queue/`).
//
// 🔴 Reaching it is the shared Reports grant (`sharedAccess`), so it no longer gates who may ACT the way
// `/images/reported`'s own grant did. Its writes remove images, change ratings and flags, unpublish 3D
// models and settle sticker escrow, so they are gated here on `/users`, as the user and post queues
// gate theirs — reading the queue is an investigation permission, acting on it is not.
const ACT_PATH = '/users';

export const load: PageServerLoad = async ({ url, locals }) => ({
  ...(await loadImageQueue('reported', url)),
  title: 'Image reports',
  canAct: canAccess(locals.user, ACT_PATH),
});

function gated<E extends RequestEvent, R>(handler: (event: E) => R) {
  return (event: E) =>
    canAccess(event.locals.user, ACT_PATH)
      ? handler(event)
      : fail(403, {
          error: 'Acting on this queue needs access to the Users page (/users), granted on /admin.',
        });
}

// The reported card's verdicts, its rating and flag corrections, and the sticker removal a
// `StickerPlacement` report carries. Not the review-flag or appeal verbs, which this queue never posts.
const { accept, block, setRating, setFlag, unpublishModel3d, bulkAccept, bulkBlock } =
  imageQueueActions;
export const actions = {
  accept: gated(accept),
  block: gated(block),
  setRating: gated(setRating),
  setFlag: gated(setFlag),
  unpublishModel3d: gated(unpublishModel3d),
  bulkAccept: gated(bulkAccept),
  bulkBlock: gated(bulkBlock),
  removePlacement: gated(stickerPlacementActions.removePlacement),
};
