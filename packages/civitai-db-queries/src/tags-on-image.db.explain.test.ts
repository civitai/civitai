import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteTagsOnImageNew,
  getTagRules,
  insertTagsOnImageNew,
  upsertTagsOnImageNew,
} from './tags-on-image.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema — parses + plans without
// executing (safe for the writes). The proc calls are the key thing to validate here: a wrong
// `upsert_tag_on_image` / `update_nsfw_levels_new` signature (arg count/types) fails to plan even though the
// compile-only test passed. Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('tags-on-image queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());
  beforeEach(() => {
    h.queries.length = 0; // explainAll explains every captured query — isolate each test's statements
  });

  it('getTagRules plans against the real schema', async () => {
    await getTagRules(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('upsertTagsOnImageNew plans: VALUES→upsert_tag_on_image and update_nsfw_levels_new (writes, not executed)', async () => {
    await upsertTagsOnImageNew(h.db, [
      { imageId: -1, tagId: -1, source: 'Rekognition', confidence: 80, automated: true },
      { imageId: -2, tagId: -2, disabled: true, needsReview: false },
    ]);
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2); // the upsert proc call + the nsfw recompute proc call
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('insertTagsOnImageNew plans: VALUES→insert_tag_on_image and update_nsfw_levels_new (writes, not executed)', async () => {
    await insertTagsOnImageNew(h.db, [
      { imageId: -1, tagId: -1, source: 'Rekognition', confidence: 80, automated: true },
      { imageId: -2, tagId: -2, disabled: true, needsReview: false },
    ]);
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2); // the insert proc call + the nsfw recompute proc call
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('deleteTagsOnImageNew plans: VALUES delete and update_nsfw_levels_new (writes, not executed)', async () => {
    await deleteTagsOnImageNew(h.db, [
      { imageId: -1, tagId: -1 },
      { imageId: -2, tagId: -2 },
    ]);
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2); // the delete + the nsfw recompute proc call
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });
});
