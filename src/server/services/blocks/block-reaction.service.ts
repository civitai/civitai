import type { ProtectedContext } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import type { AppImageReaction } from '~/shared/constants/block-reaction.constants';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';

/**
 * The reaction half of `blocks.setReactionFromApp` / `blocks.getReactionsForApp`, after the
 * router has authorized the token, the session, the scope, the flag and the ticket.
 *
 * 🔴 THE WRITE IS THE SITE'S OWN HANDLER, CALLED AS-IS. `toggleReactionHandler` is what
 * `reaction.toggle` runs, so the contest-window refusal, the entity-access check, the
 * blocked-by-owner check, metrics, rewards and notifications are the site's, byte for byte.
 * Nothing here re-implements any of them.
 *
 * What this adds is SET semantics: the site toggles, an app states the outcome it wants. The
 * current state is read first and a request that already matches it does nothing at all — no
 * toggle, so no reward, no metric move and no audit row.
 */

export type AppReactionCounts = Record<AppImageReaction, number>;

export type AppReactionState = {
  counts: AppReactionCounts;
  /** Every reaction the viewer holds on the image (a viewer may hold several). */
  viewerReactions: ReviewReactions[];
  /** True when the metric store could not answer for this image; `counts` are then zeros. */
  statsUnknown: boolean;
};

type ToggleHandler = (args: {
  ctx: ProtectedContext;
  input: { entityType: 'image'; entityId: number; reaction: ReviewReactions };
}) => Promise<'created' | 'removed' | 'noop'>;

/**
 * Does the viewer hold this reaction right now?
 *
 * Read on the PRIMARY. A replica that lags a reaction the viewer just made would answer "not
 * reacted", and the toggle would then REMOVE the reaction the app asked to keep — the inverse of
 * the request. One indexed single-row read is the price of not flipping the wrong way.
 */
async function viewerHoldsReaction(
  userId: number,
  imageId: number,
  reaction: ReviewReactions
): Promise<boolean> {
  const row = await dbWrite.imageReaction.findFirst({
    where: { imageId, userId, reaction },
    select: { id: true },
  });
  return row != null;
}

export type SetImageReactionOutcome =
  /** Already in the requested state. Nothing was written. */
  | { changed: false }
  /** The toggle ran. `result` is what the site handler reported. */
  | { changed: true; result: 'created' | 'removed' | 'noop' };

export async function setImageReactionFromApp(opts: {
  ctx: ProtectedContext;
  userId: number;
  imageId: number;
  reaction: ReviewReactions;
  reacted: boolean;
  toggle: ToggleHandler;
}): Promise<SetImageReactionOutcome> {
  const holds = await viewerHoldsReaction(opts.userId, opts.imageId, opts.reaction);
  if (holds === opts.reacted) return { changed: false };
  const result = await opts.toggle({
    ctx: opts.ctx,
    input: { entityType: 'image', entityId: opts.imageId, reaction: opts.reaction },
  });
  return { changed: true, result };
}

/**
 * Counts and the viewer's own reactions for a set of images, keyed by id.
 *
 * Counts come from `getImageMetricsObject`, the same metric read every feed uses, so a block
 * shows the number the site shows. An id the metric store cannot answer for is
 * `statsUnknown: true` with zero counts, never silently zero — `toImageV2Stats` draws the same
 * line. The viewer's reactions come from `getUserReactionsForImages`, the read behind
 * `reaction.getMyImageReactions`.
 */
export async function readImageReactionStates(opts: {
  userId: number;
  imageIds: number[];
}): Promise<Record<number, AppReactionState>> {
  if (opts.imageIds.length === 0) return {};
  const { getImageMetricsObject, getUserReactionsForImages } = await import(
    '~/server/services/image.service'
  );
  const [metrics, mine] = await Promise.all([
    getImageMetricsObject(opts.imageIds.map((id) => ({ id }))),
    getUserReactionsForImages({ imageIds: opts.imageIds, userId: opts.userId }),
  ]);
  const out: Record<number, AppReactionState> = {};
  for (const id of opts.imageIds) {
    const m = metrics[id];
    out[id] = {
      counts: {
        Like: m?.reactionLike ?? 0,
        Heart: m?.reactionHeart ?? 0,
        Laugh: m?.reactionLaugh ?? 0,
        Cry: m?.reactionCry ?? 0,
      },
      viewerReactions: mine[id] ?? [],
      statsUnknown: !m,
    };
  }
  return out;
}
