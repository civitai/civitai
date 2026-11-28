import { readFpHideStates } from '@civitai/db-queries/feature-page-comments';
import type { FpCommentState } from '$lib/fp-comment';
import { dbWrite } from './db';

/**
 * The hide state of the live Feature Pages comments among `commentIds`, by id; any other comment has
 * no entry. Read from the primary, so a state shown right after an action is the one it wrote.
 */
export async function getFpCommentStates(commentIds: number[]) {
  const rows = await readFpHideStates(dbWrite, commentIds);
  return new Map(rows.map(({ commentId, ...s }) => [commentId, s satisfies FpCommentState]));
}
