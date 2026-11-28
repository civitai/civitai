import { sql } from '@civitai/db/kysely';
import type { FpCommentState } from '$lib/fp-comment';
import { dbWrite } from './db';

export type { FpCommentState };

/**
 * The hide state of the Feature Pages comments among `commentIds`, by id; any other comment has no
 * entry. Read from the primary, so a state shown right after an action is the one it wrote.
 */
export async function getFpCommentStates(commentIds: number[]) {
  if (!commentIds.length) return new Map<number, FpCommentState>();
  const rows = await dbWrite
    .selectFrom('FeaturePageCommentMirror as m')
    .innerJoin('CommentV3 as c', 'c.id', 'm.commentId')
    .where('m.commentId', 'in', commentIds)
    .select([
      'm.commentId',
      'm.version',
      'c.hidden',
      'c.tosViolation',
      sql<string | null>`c."hiddenAt"::text`.as('hiddenAt'),
      sql<boolean>`COALESCE(c."hiddenAt" = m."scanHiddenAt", false)`.as('scanHide'),
    ])
    .execute();
  return new Map(rows.map(({ commentId, ...s }) => [commentId, s satisfies FpCommentState]));
}
