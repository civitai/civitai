import type { FpUnhideHeld } from '@civitai/db-queries/feature-page-comments';
import type { FpCommentState } from '$lib/fp-comment';
import { dbRead } from './db';
import { getFpCommentStates } from './fp-comment-state';
import { FP_LIFT_HELD } from './fp-lift-held';
import { callModEndpoint } from './user-actions.service';

const HELD: Record<FpUnhideHeld, string> = {
  ...FP_LIFT_HELD,
  gone: 'That comment no longer exists. Reload.',
  changed: 'This comment changed since you looked. Reload.',
  scan: 'The text scan hid this comment. Set its scan report to Unactioned to show it again.',
  tos: 'This comment is removed as a ToS violation, so it stays hidden.',
  flagged: 'The text scan flagged this comment, so it stays hidden.',
  scanning: 'The text scan has not cleared this text yet. Try again once it has.',
  reported: 'Someone else has an open report on this comment. Rule on it first.',
};

/**
 * Hides or unhides one Feature Pages comment as the acting moderator, bound to the state they saw.
 * On success, the state it left, read back, and what the moderator is told.
 */
export async function setFpCommentVisibility(input: {
  commentId: number;
  /** The account the page is about: another author's comment is refused. */
  authorId?: number;
  /** The open report the moderator is ruling on, which does not hold an unhide. */
  reportId?: number;
  hidden: boolean;
  seen: Pick<FpCommentState, 'version' | 'hiddenAt'>;
}): Promise<
  { ok: true; state: FpCommentState | null; message: string } | { ok: false; error: string }
> {
  if (input.authorId !== undefined) {
    const own = await dbRead
      .selectFrom('CommentV3')
      .select('id')
      .where('id', '=', input.commentId)
      .where('userId', '=', input.authorId)
      .executeTakeFirst();
    if (!own) return { ok: false, error: 'That comment is not this account’s. Reload.' };
  }
  const result = await callModEndpoint(
    'comment/fp-visibility',
    input.hidden
      ? { commentId: input.commentId, hidden: true, seenVersion: input.seen.version }
      : {
          commentId: input.commentId,
          hidden: false,
          seenVersion: input.seen.version,
          seenHiddenAt: input.seen.hiddenAt ?? '',
          ...(input.reportId ? { exceptReportId: input.reportId } : {}),
        },
    input.hidden ? 'Comment hide' : 'Comment unhide'
  );
  if (!result.ok) return result;
  const held = result.body.held;
  if (typeof held === 'string')
    return { ok: false, error: HELD[held as FpUnhideHeld] ?? 'Nothing changed. Reload.' };
  const state = (await getFpCommentStates([input.commentId])).get(input.commentId) ?? null;
  return {
    ok: true,
    state,
    message: input.hidden
      ? 'Hidden on the site now, and on the platform within minutes.'
      : input.reportId
      ? 'Visible on the site now, and on the platform once this report is closed and the next daily reconcile runs.'
      : 'Visible on the site now, and on the platform after the next daily reconcile.',
  };
}
