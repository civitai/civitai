import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteImagesByIds,
  deletePostForUser,
  deletePostRecord,
  getPostImagesForDelete,
  unpublishPostsForUser,
  updatePostNsfwLevel,
  updatePostNsfwLevels,
} from './post.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported statement against the live schema. Statements run on the
// DummyDriver (never executed); only the captured compiled SQL is EXPLAINed, so a column/type mismatch — or a
// missing `update_post_nsfw_levels` proc signature — fails here. Skips when no DB URL.
const h = explainHarness();

describe.skipIf(!h.hasDb)('post queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getPostImagesForDelete (owner-scoped) plans against the real schema', async () => {
    await getPostImagesForDelete(h.db, { postId: -1, isModerator: false });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteImagesByIds plans (write, not executed)', async () => {
    await deleteImagesByIds(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deletePostRecord plans (write, not executed)', async () => {
    await deletePostRecord(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updatePostNsfwLevels plans the recompute CTE (write, not executed)', async () => {
    await updatePostNsfwLevels(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updatePostNsfwLevel plans the stored-procedure call', async () => {
    await updatePostNsfwLevel(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishPostsForUser plans (write, not executed)', async () => {
    await unpublishPostsForUser(h.db, {
      userId: -1,
      versionIds: [-1],
      unpublishedAt: '2026-01-01',
      unpublishedBy: -1,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deletePostForUser plans (write, not executed)', async () => {
    await deletePostForUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
