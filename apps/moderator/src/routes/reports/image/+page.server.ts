import { fail, type RequestEvent } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { denied } from '$lib/server/access';
import { imageQueueActions, loadImageQueue } from '$lib/server/image-queue';
import { stickerPlacementActions } from '$lib/server/sticker-placement-actions';

// Image reports, as the image queues' card grid rather than a report table: one card per Pending
// report, judged by looking at the image. Moved here from `/images/reported` (2026-10-15), replacing
// the `/reports/[slug]` table for images — one page per report type. The page and its actions are the
// image queues' (`$lib/server/image-queue.ts`, `$lib/components/image-queue/`).
//
// 🔴 Reaching it is the shared Reports grant (`sharedAccess`), so it no longer gates who may ACT the way
// `/images/reported`'s own grant did. Its writes remove images, change ratings and flags, unpublish 3D
// models and settle sticker escrow, so they are gated on the `image.moderate` action grant — the one
// every page that removes, restores or flags images checks. Reading the queue is an investigation
// permission, acting on it is not. Accepting is gated with the rest: every verdict here is a verdict on
// an image, and a queue that could clear reports but never block would only ever say yes.
const ACT = 'image.moderate';

export const load: PageServerLoad = async ({ url, locals }) => ({
  ...(await loadImageQueue('reported', url)),
  title: 'Image reports',
  canAct: !!locals.grants[ACT],
});

function gated<E extends RequestEvent, R>(handler: (event: E) => R) {
  return (event: E) =>
    event.locals.grants[ACT] ? handler(event) : fail(403, { error: denied(ACT) });
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
