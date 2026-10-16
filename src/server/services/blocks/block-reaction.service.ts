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
 * Does the viewer hold this reaction right now? Read on the PRIMARY, so a reaction the viewer
 * made a moment ago is seen and a matching request is a true no-op.
 *
 * ⚠️ This read decides only WHETHER to toggle, not which way the toggle goes: the site's
 * `toggleReaction` makes its own existence check (on the replica outside a lag incident). So a
 * concurrent request, or replica lag, can make the toggle go the other way or match nothing. That
 * is why `setImageReactionFromApp` checks the toggle's RESULT against the requested state below.
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

/** Does a toggle result leave the reaction in the requested state? */
function resultMatches(result: 'created' | 'removed' | 'noop', reacted: boolean): boolean {
  return reacted ? result === 'created' : result === 'removed';
}

export type SetImageReactionOutcome =
  /** Nothing was written: already in the requested state, or the toggle matched no row. */
  | { changed: false }
  /** The reaction was created or removed as requested. */
  | { changed: true };

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
  const toggle = () =>
    opts.toggle({
      ctx: opts.ctx,
      input: { entityType: 'image', entityId: opts.imageId, reaction: opts.reaction },
    });
  const first = await toggle();
  if (resultMatches(first, opts.reacted)) return { changed: true };
  // 'noop': the site's delete matched no row (its replica saw a reaction the primary no longer
  // has). Nothing changed, so nothing is reported or audited as changed.
  if (first === 'noop') return { changed: false };
  // The toggle went the OTHER way — a concurrent request (a double-tap, a retry) landed between
  // the read above and the site's own check. Toggle once more to restore what was asked for, the
  // same thing a viewer re-clicking on the site would do; a second miss is an error, never a
  // silent inversion.
  const second = await toggle();
  if (resultMatches(second, opts.reacted)) return { changed: true };
  throw new Error('reaction state changed concurrently, please retry');
}

/** The viewer's reactions on one image, read on the PRIMARY — the state right after a write. */
export async function readViewerImageReactionsOnPrimary(
  userId: number,
  imageId: number
): Promise<ReviewReactions[]> {
  const rows = await dbWrite.imageReaction.findMany({
    where: { imageId, userId },
    select: { reaction: true },
  });
  return rows.map((r) => r.reaction);
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
