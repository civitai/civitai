import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteCommentForUser,
  deleteCommentReactionForUser,
  deleteCommentV2ForUser,
  deleteCommentV2ReactionForUser,
} from './comment.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('comment per-table deletes', () => {
  const simpleDeletes: Array<[string, (userId: number) => unknown, string]> = [
    ['CommentReaction', (u) => deleteCommentReactionForUser(h.db, u), 'CommentReaction'],
    ['CommentV2Reaction', (u) => deleteCommentV2ReactionForUser(h.db, u), 'CommentV2Reaction'],
    ['CommentV2', (u) => deleteCommentV2ForUser(h.db, u), 'CommentV2'],
    ['Comment', (u) => deleteCommentForUser(h.db, u), 'Comment'],
  ];

  it.each(simpleDeletes)('%s: delete from table where userId', async (_name, fn, table) => {
    await fn(7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(`delete from "${table}" where "userId" = $1`);
    expect(parameters).toEqual([7]);
  });
});
