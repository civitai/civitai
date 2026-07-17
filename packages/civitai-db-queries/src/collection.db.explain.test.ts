import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteCollectionForUser,
  setCollectionItemNsfwLevel,
  updateCollectionItemsStatus,
  updateCollectionsNsfwLevels,
} from './collection.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported statement against the live schema. Statements run on the
// DummyDriver (never executed); only the captured compiled SQL is EXPLAINed, so a column/type/enum mismatch
// against the real CollectionItem/Image/Collection tables fails here. Skips when no DB URL.
const h = explainHarness();

describe.skipIf(!h.hasDb)('collection queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('updateCollectionItemsStatus plans (write, not executed)', async () => {
    await updateCollectionItemsStatus(h.db, {
      collectionId: -1,
      collectionItemIds: [-1, -2],
      status: 'ACCEPTED',
      userId: -1,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setCollectionItemNsfwLevel plans (write, not executed)', async () => {
    await setCollectionItemNsfwLevel(h.db, { imageId: -1, nsfwLevel: 4 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateCollectionsNsfwLevels plans the recompute CTE (write, not executed)', async () => {
    await updateCollectionsNsfwLevels(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteCollectionForUser plans (write, not executed)', async () => {
    await deleteCollectionForUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
