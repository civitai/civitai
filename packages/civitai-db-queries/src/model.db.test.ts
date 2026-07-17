import { beforeEach, describe, expect, it } from 'vitest';
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
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('reads', () => {
  it('getModelVersionMetaForModel selects id + meta scoped to the model', async () => {
    await getModelVersionMetaForModel(h.db, 42);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('select "id", "meta" from "ModelVersion" where "modelId" = $1');
    expect(parameters).toEqual([42]);
  });

  it('getModelVersionIdsByModelId selects only ids', async () => {
    await getModelVersionIdsByModelId(h.db, 42);
    const { sql } = h.lastQuery();
    expect(sql).toBe('select "id" from "ModelVersion" where "modelId" = $1');
  });

  it('getModelOwner selects owner + nsfw flags', async () => {
    await getModelOwner(h.db, 7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('select "id", "userId", "nsfw", "nsfwLevel" from "Model" where "id" = $1');
    expect(parameters).toEqual([7]);
  });
});

describe('unpublishModelById statements', () => {
  it('unpublishModel sets status/meta/updatedAt and returns userId', async () => {
    await unpublishModel(h.db, { id: 5, status: 'UnpublishedViolation', meta: { a: 1 } });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "Model" set "status" = $1, "meta" = $2::jsonb, "updatedAt" = $3 ' +
        'where "id" = $4 returning "userId"'
    );
    expect(parameters[0]).toBe('UnpublishedViolation');
    expect(parameters[1]).toBe(JSON.stringify({ a: 1 }));
    expect(parameters[2]).toBeInstanceOf(Date); // updatedAt stamped explicitly, not by a trigger
    expect(parameters[3]).toBe(5);
  });

  it('unpublishModelVersions cascades the publish-visible statuses', async () => {
    await unpublishModelVersions(h.db, { modelId: 5, status: 'Unpublished', meta: {} });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "ModelVersion" set "status" = $1, "meta" = $2::jsonb, "updatedAt" = $3 ' +
        'where "modelId" = $4 and "status" in ($5, $6)'
    );
    expect(parameters[3]).toBe(5);
    expect(parameters[4]).toBe('Published');
    expect(parameters[5]).toBe('Scheduled');
  });

  it('unpublishPostsForModel nulls publishedAt + merges metadata, guarded IN', async () => {
    await unpublishPostsForModel(h.db, {
      userId: 9,
      versionIds: [1, 2],
      unpublishedAt: '2026-01-01T00:00:00.000Z',
      unpublishedBy: 9,
    });
    const { sql } = h.lastQuery();
    expect(sql).toContain('update "Post" set');
    expect(sql).toContain('"publishedAt" = $3');
    expect(sql).toContain('\'prevPublishedAt\', "publishedAt"');
    expect(sql).toContain('"modelVersionId" in ($5, $6)');
    expect(sql).not.toContain('in ()');
  });

  it('unpublishPostsForModel short-circuits an empty version list', async () => {
    const result = await unpublishPostsForModel(h.db, {
      userId: 9,
      versionIds: [],
      unpublishedAt: 'x',
      unpublishedBy: 9,
    });
    expect(result).toBeUndefined();
    expect(h.queries).toHaveLength(0);
  });
});

describe('deleteModelById statements', () => {
  it('softDeleteModel stamps deletedAt/status/deletedBy/updatedAt and returns row', async () => {
    await softDeleteModel(h.db, { id: 3, userId: 9 });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "Model" set "deletedAt" = $1, "status" = $2, "deletedBy" = $3, "updatedAt" = $4 ' +
        'where "id" = $5 returning "id", "userId", "nsfwLevel"'
    );
    expect(parameters[1]).toBe('Deleted');
    expect(parameters[2]).toBe(9);
    expect(parameters[4]).toBe(3);
  });

  it('softDeleteModelVersions cascades publish-visible versions to Deleted', async () => {
    await softDeleteModelVersions(h.db, { modelId: 3 });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "ModelVersion" set "status" = $1, "updatedAt" = $2 ' +
        'where "modelId" = $3 and "status" in ($4, $5)'
    );
    expect(parameters[0]).toBe('Deleted');
  });

  it('unpublishPostsForDeletedModel keeps publishedAt (no null-out)', async () => {
    await unpublishPostsForDeletedModel(h.db, {
      userId: 9,
      versionIds: [1],
      unpublishedAt: 'x',
      unpublishedBy: 9,
    });
    const { sql } = h.lastQuery();
    expect(sql).toContain('update "Post" set "metadata"');
    expect(sql).not.toContain('"publishedAt" = $');
    expect(sql).not.toContain('prevPublishedAt');
    expect(sql).toContain('"modelVersionId" in ($4)');
  });

  it('unpublishPostsForDeletedModel short-circuits an empty version list', async () => {
    await unpublishPostsForDeletedModel(h.db, {
      userId: 9,
      versionIds: [],
      unpublishedAt: 'x',
      unpublishedBy: 9,
    });
    expect(h.queries).toHaveLength(0);
  });
});

describe('restoreModelById statements', () => {
  it('restoreModel derives status from publishedAt and returns userId', async () => {
    await restoreModel(h.db, 11);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('UPDATE "Model"');
    expect(sql).toContain('"deletedAt" = NULL');
    expect(sql).toContain('WHEN "publishedAt" IS NULL      THEN \'Draft\'::"ModelStatus"');
    expect(sql).toContain('RETURNING "userId"');
    expect(parameters).toEqual([11]);
  });

  it('restoreModelVersions derives version status from publishedAt', async () => {
    await restoreModelVersions(h.db, 11);
    const { sql } = h.lastQuery();
    expect(sql).toContain('UPDATE "ModelVersion"');
    expect(sql).toContain('"modelId" = $1');
    expect(sql).toContain('AND "status" = \'Deleted\'::"ModelStatus"');
  });
});

describe('permaDeleteModelById statements', () => {
  it('getModelFileUrlsByModelId joins ModelVersion and returns urls', async () => {
    await getModelFileUrlsByModelId(h.db, 8);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'select "ModelFile"."url" from "ModelFile" ' +
        'inner join "ModelVersion" on "ModelVersion"."id" = "ModelFile"."modelVersionId" ' +
        'where "ModelVersion"."modelId" = $1'
    );
    expect(parameters).toEqual([8]);
  });

  it('getPostIdsForModelVersions scopes by userId + versions, guarded', async () => {
    await getPostIdsForModelVersions(h.db, { userId: 9, versionIds: [1, 2] });
    const { sql } = h.lastQuery();
    expect(sql).toBe(
      'select "id" from "Post" where "userId" = $1 and "modelVersionId" in ($2, $3)'
    );
  });

  it('getPostIdsForModelVersions short-circuits an empty version list', async () => {
    const result = await getPostIdsForModelVersions(h.db, { userId: 9, versionIds: [] });
    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('getImageIdsByPostIds / deleteImagesByPostIds guard empty arrays', async () => {
    expect(await getImageIdsByPostIds(h.db, [])).toEqual([]);
    await deleteImagesByPostIds(h.db, []);
    expect(h.queries).toHaveLength(0);
  });

  it('deletePostsForModelVersions guards empty and scopes when present', async () => {
    await deletePostsForModelVersions(h.db, { userId: 9, versionIds: [] });
    expect(h.queries).toHaveLength(0);
    await deletePostsForModelVersions(h.db, { userId: 9, versionIds: [4] });
    const { sql } = h.lastQuery();
    expect(sql).toBe('delete from "Post" where "userId" = $1 and "modelVersionId" in ($2)');
  });

  it('deleteModel removes the row and returns id/userId', async () => {
    await deleteModel(h.db, 8);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('delete from "Model" where "id" = $1 returning "id", "userId"');
    expect(parameters).toEqual([8]);
  });
});

describe('updateModel (generic)', () => {
  it('sets provided columns + auto-stamped updatedAt, keyed by id, returning the row', async () => {
    await updateModel(h.db, { id: 2, locked: true });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "Model" set "locked" = $1, "updatedAt" = $2 where "id" = $3 returning *'
    );
    expect(parameters[0]).toBe(true);
    expect(parameters[1]).toBeInstanceOf(Date); // @updatedAt stamped explicitly, not by a trigger
    expect(parameters[2]).toBe(2);
  });

  it('stamps updatedAt even when only the id is passed', async () => {
    await updateModel(h.db, { id: 5 });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('update "Model" set "updatedAt" = $1 where "id" = $2 returning *');
    expect(parameters[0]).toBeInstanceOf(Date);
    expect(parameters[1]).toBe(5);
  });
});

describe('lock toggles', () => {
  it('setModelCommentsLocked jsonb_sets meta.commentsLocked (keeps updatedAt, no bump)', async () => {
    await setModelCommentsLocked(h.db, { id: 2, locked: false });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "Model" set "meta" = jsonb_set(meta, \'{commentsLocked}\', to_jsonb($1::boolean)), ' +
        '"updatedAt" = "updatedAt" where "id" = $2'
    );
    expect(sql).toContain('"updatedAt" = "updatedAt"'); // self-reference: keep current value, no bump
    expect(parameters).toEqual([false, 2]);
  });
});

describe('updateModelModerationById', () => {
  it('sets only provided fields + updatedAt, meta as jsonb', async () => {
    await updateModelModerationById(h.db, {
      id: 6,
      poi: true,
      minor: false,
      nsfwLevel: 4,
      lockedProperties: ['nsfw', 'poi'],
      meta: { flagged: true },
    });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('"poi" = $');
    expect(sql).toContain('"minor" = $');
    expect(sql).toContain('"nsfwLevel" = $');
    expect(sql).toContain('"lockedProperties" = $');
    expect(sql).toContain('"meta" = $');
    expect(sql).toContain('::jsonb');
    expect(sql).toContain('"updatedAt" = $');
    expect(sql).not.toContain('"nsfw" =');
    expect(sql).not.toContain('"status" =');
    expect(parameters).toContain(JSON.stringify({ flagged: true }));
  });
});

describe('setModelsCategory statements', () => {
  it('deleteModelCategories joins Model and guards both arrays', async () => {
    await deleteModelCategories(h.db, { userId: 9, modelIds: [1, 2], categoryIds: [10, 11] });
    const { sql } = h.lastQuery();
    expect(sql).toContain('DELETE');
    expect(sql).toContain('FROM "TagsOnModels" tom');
    expect(sql).toContain('USING "Model" m');
    expect(sql).toContain('"modelId" IN ($2, $3)');
    expect(sql).toContain('"tagId" IN ($4, $5)');
    expect(sql).not.toContain('IN ()');
  });

  it('deleteModelCategories short-circuits when either array is empty', async () => {
    await deleteModelCategories(h.db, { userId: 9, modelIds: [], categoryIds: [10] });
    await deleteModelCategories(h.db, { userId: 9, modelIds: [1], categoryIds: [] });
    expect(h.queries).toHaveLength(0);
  });

  it('insertModelCategory inserts with ON CONFLICT DO NOTHING, guarded', async () => {
    await insertModelCategory(h.db, { userId: 9, modelIds: [1, 2], categoryId: 10 });
    const { sql } = h.lastQuery();
    expect(sql).toContain('INSERT INTO "TagsOnModels" ("modelId", "tagId")');
    expect(sql).toContain('ON CONFLICT ("modelId", "tagId") DO NOTHING');
    expect(sql).toContain('m.id IN ($3, $4)');
  });

  it('insertModelCategory short-circuits an empty model list', async () => {
    await insertModelCategory(h.db, { userId: 9, modelIds: [], categoryId: 10 });
    expect(h.queries).toHaveLength(0);
  });
});

describe('unpublishModelVersionById statements', () => {
  it('unpublishModelVersion sets status/meta/updatedAt, returns id + modelId', async () => {
    await unpublishModelVersion(h.db, { id: 5, status: 'Unpublished', meta: {} });
    const { sql } = h.lastQuery();
    expect(sql).toBe(
      'update "ModelVersion" set "status" = $1, "meta" = $2::jsonb, "updatedAt" = $3 ' +
        'where "id" = $4 returning "id", "modelId"'
    );
  });

  it('unpublishPostsForModelVersion targets the single version', async () => {
    await unpublishPostsForModelVersion(h.db, {
      userId: 9,
      versionId: 5,
      unpublishedAt: 'x',
      unpublishedBy: 9,
    });
    const { sql } = h.lastQuery();
    expect(sql).toContain('"modelVersionId" = $');
    expect(sql).toContain('"publishedAt" = $');
    expect(sql).toContain('prevPublishedAt');
  });
});

describe('nsfwLevel recompute', () => {
  it('updateModelNsfwLevels guards empty ids', async () => {
    const result = await updateModelNsfwLevels(h.db, []);
    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('updateModelNsfwLevels emits bit_or CTE + forced nsfw flag', async () => {
    await updateModelNsfwLevels(h.db, [1, 2]);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('bit_or(mv."nsfwLevel")');
    expect(sql).toContain('mv."modelId" IN ($1, $2)');
    expect(sql).toContain('WHEN m.nsfw = TRUE THEN $3'); // nsfwBrowsingLevelsFlag bound as a param
    expect(parameters[2]).toBe(60); // 4|8|16|32
    expect(sql).toContain('RETURNING m.id');
  });

  it('updateModelVersionNsfwLevels guards empty ids', async () => {
    const result = await updateModelVersionNsfwLevels(h.db, { modelVersionIds: [] });
    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('updateModelVersionNsfwLevels default includes system rows (no userId>0 guard)', async () => {
    await updateModelVersionNsfwLevels(h.db, { modelVersionIds: [1] });
    const { sql } = h.lastQuery();
    expect(sql).toContain('mv.id IN ($2)'); // $1 is the bound nsfw flag
    expect(sql).not.toContain('m."userId" > 0');
  });

  it('updateModelVersionNsfwLevels excludes system rows when flag is false', async () => {
    await updateModelVersionNsfwLevels(h.db, {
      modelVersionIds: [1],
      updateSystemNsfwLevel: false,
    });
    const { sql } = h.lastQuery();
    expect(sql).toContain('AND m."userId" > 0');
  });
});

describe('getTrainingModelsForModerators', () => {
  it('filters trained + non-deleted with the training-file EXISTS and nests versions/files', async () => {
    await getTrainingModelsForModerators(h.db, { limit: 20 });
    const { sql } = h.lastQuery();
    expect(sql).toContain('from "Model"');
    expect(sql).toContain('"Model"."uploadType" = $');
    expect(sql).toContain('"Model"."deletedAt" is null');
    expect(sql).toContain("'Training Data'");
    expect(sql).toContain('coalesce');
    expect(sql).toContain('"profilePicture"');
    expect(sql).toContain('"files"');
    expect(sql).toContain('"modelVersions"');
    expect(sql).toContain('order by "Model"."id" desc');
    expect(sql).toContain('limit $');
    expect(sql).not.toContain('in ()');
  });

  it('applies cursor, username, date range, cannotPublish and workflowId filters', async () => {
    await getTrainingModelsForModerators(h.db, {
      limit: 10,
      cursor: 500,
      username: 'alice',
      dateFrom: new Date('2026-01-01'),
      dateTo: new Date('2026-02-01'),
      cannotPublish: true,
      workflowId: 'wf-123',
    });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('"Model"."id" < $');
    expect(sql).toContain('u.username =');
    expect(sql).toContain('"Model"."createdAt" >=');
    expect(sql).toContain('"Model"."createdAt" <=');
    expect(sql).toContain("meta -> 'cannotPublish' = 'true'::jsonb");
    expect(sql).toContain("#>> '{trainingResults,workflowId}'");
    expect(parameters).toContain('alice');
    expect(parameters).toContain('wf-123');
    expect(parameters).toContain(500);
  });

  it('cannotPublish=false uses IS DISTINCT FROM', async () => {
    await getTrainingModelsForModerators(h.db, { cannotPublish: false });
    const { sql } = h.lastQuery();
    expect(sql).toContain("meta -> 'cannotPublish' IS DISTINCT FROM 'true'::jsonb");
  });
});

describe('bulkUnpublish cores', () => {
  it('getModelsToUnpublishForUser nests versions via json subquery', async () => {
    await getModelsToUnpublishForUser(h.db, 7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('from "Model"');
    // The correlated json subquery's params bind first, then the outer query's.
    expect(sql).toContain('"ModelVersion"."status" in ($1, $2)');
    expect(sql).toContain('"Model"."userId" = $3');
    expect(sql).toContain('"Model"."status" in ($4, $5)');
    expect(parameters).toEqual(['Published', 'Scheduled', 7, 'Published', 'Scheduled']);
  });

  it('unpublishModelsForUser merges meta and guards empty ids', async () => {
    const empty = await unpublishModelsForUser(h.db, { modelIds: [], meta: { a: 1 } });
    expect(empty).toEqual([]);
    expect(h.queries).toHaveLength(0);

    await unpublishModelsForUser(h.db, { modelIds: [1, 2], meta: { a: 1 } });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "Model" set "status" = $1, "meta" = COALESCE("meta", \'{}\'::jsonb) || $2::jsonb, ' +
        '"updatedAt" = "updatedAt" where "id" in ($3, $4)'
    );
    expect(sql).toContain('"updatedAt" = "updatedAt"'); // raw-SQL parity: self-reference, no bump
    expect(parameters).toEqual(['UnpublishedViolation', JSON.stringify({ a: 1 }), 1, 2]);
  });

  it('unpublishModelVersionsForUser sets Unpublished and guards empty ids', async () => {
    const empty = await unpublishModelVersionsForUser(h.db, { versionIds: [], meta: {} });
    expect(empty).toEqual([]);
    expect(h.queries).toHaveLength(0);

    await unpublishModelVersionsForUser(h.db, { versionIds: [3], meta: { a: 1 } });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('update "ModelVersion" set "status" = $1');
    expect(parameters[0]).toBe('Unpublished');
  });
});

describe('per-user model content deletes', () => {
  it('purgeUserModels reassigns to -1 and bumps updatedAt when not removing', async () => {
    await purgeUserModels(h.db, { userId: 7, removeModels: false });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('update "Model" set "userId" = $1, "updatedAt" = $2 where "userId" = $3');
    expect(parameters[0]).toBe(-1);
    expect(parameters[1]).toBeInstanceOf(Date);
    expect(parameters[2]).toBe(7);
  });

  it('purgeUserModels hard-deletes and bumps updatedAt when removing', async () => {
    await purgeUserModels(h.db, { userId: 7, removeModels: true });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe(
      'update "Model" set "deletedAt" = $1, "status" = $2, "updatedAt" = $3 where "userId" = $4'
    );
    expect(parameters[1]).toBe('Deleted');
  });

  it('deleteModelForUser deletes the user models', async () => {
    await deleteModelForUser(h.db, 7);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('delete from "Model" where "userId" = $1');
    expect(parameters).toEqual([7]);
  });
});
