import { type FpCommentState, getFpCommentStates } from './fp-comment-state';
import { dbRead } from './db';
import { callModEndpoint } from './user-actions.service';

const HELD: Record<string, string> = {
  gone: 'That comment no longer exists. Reload.',
  changed: 'This comment changed since you looked. Reload.',
  scan: 'The text scan hid this comment. Set its scan report to Unactioned to show it again.',
  tos: 'This comment is removed as a ToS violation, so it stays hidden.',
  foreign: 'It was hidden by another action on the platform first, so it stays hidden.',
  held: 'This comment is held for a child-safety check, so it stays hidden.',
  flagged: 'The text scan flagged this comment, so it stays hidden.',
  author: "The comment's author is banned or muted, so it stays hidden.",
  reported: 'Someone else has an open report on this comment. Rule on it first.',
  pushing: 'This comment is being sent to the platform. Try again in a minute.',
};

export const FP_HIDDEN_MESSAGE = 'Hidden on the site now, and on the platform within minutes.';
export const FP_SHOWN_MESSAGE =
  'Visible on the site now, and on the platform after the next daily reconcile.';

/**
 * Hides or unhides one Feature Pages comment as the acting moderator, bound to the state they saw.
 * On success, the state it left, read back.
 */
export async function setFpCommentVisibility(input: {
  commentId: number;
  /** The account the page is about: another author's comment is refused. */
  authorId?: number;
  /** The open report the moderator is ruling on, which does not hold an unhide. */
  reportId?: number;
  hidden: boolean;
  seen: Pick<FpCommentState, 'version' | 'hiddenAt'>;
}): Promise<{ ok: true; state: FpCommentState | null } | { ok: false; error: string }> {
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
    return { ok: false, error: HELD[held] ?? 'Nothing changed. Reload.' };
  if (result.body.hidden !== input.hidden) return { ok: false, error: 'Nothing changed. Reload.' };
  const state = (await getFpCommentStates([input.commentId])).get(input.commentId) ?? null;
  return { ok: true, state };
}

/** The comment a comment report is on, or null when the report is gone. */
export async function getReportCommentId(reportId: number) {
  const row = await dbRead
    .selectFrom('CommentV3Report')
    .select('commentId')
    .where('reportId', '=', reportId)
    .executeTakeFirst();
  return row?.commentId ?? null;
}
