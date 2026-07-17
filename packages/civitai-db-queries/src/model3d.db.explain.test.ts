import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteModel3D,
  getModel3DsByThumbnailImageIds,
  restoreModel3D,
  setModel3DMetricNsfwLevel,
  setModel3DNsfwLevelRow,
  toggleModel3DFlag,
  unpublishModel3d,
  updateModel3D,
  updateModel3DNsfwLevelForThumbnailImage,
  updateModel3DNsfwLevels,
} from './model3d.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema. This never executes the
// statement — safe for the write below — but it parses + plans it, so a query whose columns, joins, or types
// don't resolve against the real database fails here even though the compile-only test passed. Skips when no
// DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('model3d queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getModel3DsByThumbnailImageIds plans against the real schema', async () => {
    await getModel3DsByThumbnailImageIds(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateModel3D plans (write, not executed)', async () => {
    await updateModel3D(h.db, { id: -1, status: 'Unpublished' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishModel3d plans (write, not executed)', async () => {
    await unpublishModel3d(h.db, { id: -1, userId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteModel3D plans (write, not executed)', async () => {
    await deleteModel3D(h.db, { id: -1, userId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('restoreModel3D (Deleted branch) plans', async () => {
    await restoreModel3D(h.db, { id: -1, status: 'Deleted' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('restoreModel3D (Unpublished branch) plans', async () => {
    await restoreModel3D(h.db, { id: -1, status: 'Unpublished' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setModel3DNsfwLevelRow plans', async () => {
    await setModel3DNsfwLevelRow(h.db, { id: -1, nsfwLevel: 4, lockedProperties: ['nsfwLevel'] });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setModel3DMetricNsfwLevel plans', async () => {
    await setModel3DMetricNsfwLevel(h.db, { model3dId: -1, nsfwLevel: 4 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('toggleModel3DFlag plans', async () => {
    await toggleModel3DFlag(h.db, {
      id: -1,
      field: 'poi',
      value: true,
      lockedProperties: ['poi'],
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateModel3DNsfwLevels plans (writable CTE, not executed)', async () => {
    await updateModel3DNsfwLevels(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateModel3DNsfwLevelForThumbnailImage plans', async () => {
    await updateModel3DNsfwLevelForThumbnailImage(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
