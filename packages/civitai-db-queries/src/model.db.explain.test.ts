import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteImagesByPostIds,
  deleteModel,
  deleteModelCategories,
  deleteModelForUser,
  deletePostsForModelVersions,
  getImageIdsByPostIds,
  getModelFileUrlsByModelId,
  getModelOwner,
  getModelsToUnpublishForUser,
  getModelVersionIdsByModelId,
  getModelVersionMetaForModel,
  getPostIdsForModelVersions,
  getTrainingModelsForModerators,
  insertModelCategory,
  purgeUserModels,
  restoreModel,
  restoreModelVersions,
  setModelCommentsLocked,
  softDeleteModel,
  softDeleteModelVersions,
  unpublishModel,
  unpublishModelsForUser,
  unpublishModelVersion,
  unpublishModelVersions,
  unpublishModelVersionsForUser,
  unpublishPostsForDeletedModel,
  unpublishPostsForModel,
  unpublishPostsForModelVersion,
  updateModel,
  updateModelModerationById,
  updateModelNsfwLevels,
  updateModelVersionNsfwLevels,
} from './model.db';
import { explainHarness } from './test/harness';

// DB-backed tier: compile each query with the harness's compile-only `db` (safe for writes — nothing
// executes) then EXPLAIN (no ANALYZE) it against the live schema, so a column/join/type/proc mismatch fails
// here even though the compile-only suite passed. Skips when no DB URL is available.
const h = explainHarness();

describe.skipIf(!h.hasDb)('model moderation queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getModelVersionMetaForModel plans', async () => {
    await getModelVersionMetaForModel(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getModelVersionIdsByModelId plans', async () => {
    await getModelVersionIdsByModelId(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getModelOwner plans', async () => {
    await getModelOwner(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishModel plans (write, not executed)', async () => {
    await unpublishModel(h.db, { id: -1, status: 'Unpublished', meta: { a: 1 } });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishModelVersions plans (write, not executed)', async () => {
    await unpublishModelVersions(h.db, { modelId: -1, status: 'Unpublished', meta: {} });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishPostsForModel plans (write, not executed)', async () => {
    await unpublishPostsForModel(h.db, {
      userId: -1,
      versionIds: [-1, -2],
      unpublishedAt: '2026-01-01T00:00:00.000Z',
      unpublishedBy: -1,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('softDeleteModel plans (write, not executed)', async () => {
    await softDeleteModel(h.db, { id: -1, userId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('softDeleteModelVersions plans (write, not executed)', async () => {
    await softDeleteModelVersions(h.db, { modelId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishPostsForDeletedModel plans (write, not executed)', async () => {
    await unpublishPostsForDeletedModel(h.db, {
      userId: -1,
      versionIds: [-1],
      unpublishedAt: '2026-01-01T00:00:00.000Z',
      unpublishedBy: -1,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('restoreModel plans (write, not executed)', async () => {
    await restoreModel(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('restoreModelVersions plans (write, not executed)', async () => {
    await restoreModelVersions(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getModelFileUrlsByModelId plans', async () => {
    await getModelFileUrlsByModelId(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getPostIdsForModelVersions plans', async () => {
    await getPostIdsForModelVersions(h.db, { userId: -1, versionIds: [-1] });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getImageIdsByPostIds plans', async () => {
    await getImageIdsByPostIds(h.db, [-1]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteImagesByPostIds plans (write, not executed)', async () => {
    await deleteImagesByPostIds(h.db, [-1]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deletePostsForModelVersions plans (write, not executed)', async () => {
    await deletePostsForModelVersions(h.db, { userId: -1, versionIds: [-1] });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteModel plans (write, not executed)', async () => {
    await deleteModel(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateModel plans (write, not executed)', async () => {
    await updateModel(h.db, { id: -1, locked: true });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setModelCommentsLocked plans (write, not executed)', async () => {
    await setModelCommentsLocked(h.db, { id: -1, locked: true });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateModelModerationById plans (write, not executed)', async () => {
    await updateModelModerationById(h.db, {
      id: -1,
      poi: true,
      nsfw: false,
      minor: false,
      sfwOnly: true,
      nsfwLevel: 4,
      tosViolation: false,
      status: 'Unpublished',
      lockedProperties: ['nsfw', 'poi'],
      meta: { flagged: true },
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteModelCategories plans (write, not executed)', async () => {
    await deleteModelCategories(h.db, { userId: -1, modelIds: [-1], categoryIds: [-1] });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('insertModelCategory plans (write, not executed)', async () => {
    await insertModelCategory(h.db, { userId: -1, modelIds: [-1], categoryId: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishModelVersion plans (write, not executed)', async () => {
    await unpublishModelVersion(h.db, { id: -1, status: 'Unpublished', meta: {} });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishPostsForModelVersion plans (write, not executed)', async () => {
    await unpublishPostsForModelVersion(h.db, {
      userId: -1,
      versionId: -1,
      unpublishedAt: '2026-01-01T00:00:00.000Z',
      unpublishedBy: -1,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateModelNsfwLevels plans (write, not executed)', async () => {
    await updateModelNsfwLevels(h.db, [-1, -2]);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateModelVersionNsfwLevels plans, both kill-switch branches', async () => {
    await updateModelVersionNsfwLevels(h.db, { modelVersionIds: [-1] });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
    await updateModelVersionNsfwLevels(h.db, {
      modelVersionIds: [-1],
      updateSystemNsfwLevel: false,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getTrainingModelsForModerators plans with all filters', async () => {
    await getTrainingModelsForModerators(h.db, {
      limit: 20,
      cursor: 999999999,
      username: '__none__',
      dateFrom: new Date('2026-01-01'),
      dateTo: new Date('2026-02-01'),
      cannotPublish: true,
      workflowId: 'wf-none',
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getTrainingModelsForModerators plans with cannotPublish=false / no filters', async () => {
    await getTrainingModelsForModerators(h.db, { cannotPublish: false });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getModelsToUnpublishForUser plans', async () => {
    await getModelsToUnpublishForUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishModelsForUser plans', async () => {
    await unpublishModelsForUser(h.db, { modelIds: [-1], meta: { unpublishedReason: 'other' } });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('unpublishModelVersionsForUser plans', async () => {
    await unpublishModelVersionsForUser(h.db, {
      versionIds: [-1],
      meta: { unpublishedReason: 'other' },
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('purgeUserModels plans (both branches)', async () => {
    await purgeUserModels(h.db, { userId: -1, removeModels: false });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
    await purgeUserModels(h.db, { userId: -1, removeModels: true });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteModelForUser plans', async () => {
    await deleteModelForUser(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
