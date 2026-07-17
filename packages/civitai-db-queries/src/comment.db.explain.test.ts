import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteCommentForUser,
  deleteCommentReactionForUser,
  deleteCommentV2ForUser,
  deleteCommentV2ReactionForUser,
} from './comment.db';
import { explainHarness } from './test/harness';

// DB-backed tier: pass the compile-only `db` (so writes compile but never execute), then EXPLAIN the compiled
// SQL against the live schema. Validates that every ported query's columns/joins/types/enums resolve. Skips
// when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('comment queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  const simpleDeletes: Array<[string, () => Promise<unknown>]> = [
    ['deleteCommentReactionForUser', () => deleteCommentReactionForUser(h.db, -1)],
    ['deleteCommentV2ReactionForUser', () => deleteCommentV2ReactionForUser(h.db, -1)],
    ['deleteCommentV2ForUser', () => deleteCommentV2ForUser(h.db, -1)],
    ['deleteCommentForUser', () => deleteCommentForUser(h.db, -1)],
  ];

  it.each(simpleDeletes)('%s plans', async (_name, fn) => {
    await fn();
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
