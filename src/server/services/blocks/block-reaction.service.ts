import type { ProtectedContext } from '~/server/createContext';
import { dbWrite } from '~/server/db/client';
import { isPrismaUniqueViolation } from '~/server/utils/errorHandling';
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

/** The viewer's reactions on one image, read on the PRIMARY — the state right after a write. */
async function readViewerImageReactionsOnPrimary(
  userId: number,
  imageId: number
): Promise<ReviewReactions[]> {
  const rows = await dbWrite.imageReaction.findMany({
    where: { imageId, userId },
    select: { reaction: true },
  });
  return rows.map((r) => r.reaction);
}

export type SetImageReactionOutcome = {
  /** Did THIS request write a change (create or remove)? Drives the audit row. */
  changed: boolean;
  /** When `changed`: the direction this request wrote — true for a create, false for a removal. */
  wroteReacted: boolean;
  /** Whether the viewer holds the reaction NOW, read on the primary after the write. */
  reacted: boolean;
  /** Every reaction the viewer holds on the image now, read on the primary. */
  viewerReactions: ReviewReactions[];
};

/** Was this a unique violation — the row already existed? `throwDbError` keeps the Prisma error as `cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 3; depth++) {
    if (isPrismaUniqueViolation(e)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Set the viewer's reaction to the requested state.
 *
 * Two different questions get two different sources, on purpose:
 *   - WHAT THIS REQUEST DID — `changed` / `wroteReacted`, and so the audit row — comes from the
 *     site handler's own result (`created` / `removed` / `noop`). A before/after comparison would
 *     blame this app for a concurrent change it never made, or miss a create that paid rewards and
 *     was then undone by a racing request.
 *   - WHAT IS TRUE NOW — `reacted` / `viewerReactions`, the reply — comes from a read-back on the
 *     PRIMARY.
 *
 * ⚠️ The primary read decides only WHETHER to toggle, not which way the toggle goes: the site's
 * `toggleReaction` makes its own existence check, on the replica outside a lag incident. So a
 * concurrent request (a double-tap, a retry) or replica lag can make the toggle go the other way,
 * or match no row. Nothing here fights that — a corrective second toggle would run its own stale
 * check milliseconds after its own write and usually miss again. A block that sees `reacted`
 * differ from what it asked for knows the request did not apply.
 *
 * If the site handler THROWS, the error is classified, never inferred from a state comparison
 * (a comparison cannot tell this request's write from a concurrent one). A unique violation means
 * the row was already there — a racing request or a stale replica check created it first — so this
 * request wrote nothing: `changed: false`, and the reply carries the read-back truth. Any other
 * error is rethrown and audited as a failed attempt. KNOWN LIMIT: a handler that throws AFTER its
 * own insert committed (a later step failing) is audited as failed although the reaction landed;
 * the reply is an error and the block's retry is a correct no-op.
 */
export async function setImageReactionFromApp(opts: {
  ctx: ProtectedContext;
  userId: number;
  imageId: number;
  reaction: ReviewReactions;
  reacted: boolean;
  toggle: ToggleHandler;
}): Promise<SetImageReactionOutcome> {
  const held = await viewerHoldsReaction(opts.userId, opts.imageId, opts.reaction);
  let result: 'created' | 'removed' | 'noop' | null = null;
  let failure: { error: unknown } | null = null;
  // Already in the requested state: no toggle — so no reward, no metric move, no audit row.
  if (held !== opts.reacted) {
    try {
      result = await opts.toggle({
        ctx: opts.ctx,
        input: { entityType: 'image', entityId: opts.imageId, reaction: opts.reaction },
      });
    } catch (error) {
      failure = { error };
    }
  }
  const viewerReactions = await readViewerImageReactionsOnPrimary(opts.userId, opts.imageId);
  const holds = viewerReactions.includes(opts.reaction);
  if (failure) {
    if (!isUniqueViolation(failure.error)) throw failure.error;
    return { changed: false, wroteReacted: false, reacted: holds, viewerReactions };
  }
  const changed = result === 'created' || result === 'removed';
  return { changed, wroteReacted: result === 'created', reacted: holds, viewerReactions };
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
