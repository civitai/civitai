import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteModel3D,
  getModel3DsByThumbnailImageIds,
  restoreModel3D,
  setModel3DMetricNsfwLevel,
  setModel3DNsfwLevel,
  setModel3DNsfwLevelRow,
  toggleModel3DFlag,
  unpublishModel3d,
  updateModel3D,
  updateModel3DNsfwLevelForThumbnailImage,
  updateModel3DNsfwLevels,
} from './model3d.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getModel3DsByThumbnailImageIds', () => {
  it('short-circuits an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await getModel3DsByThumbnailImageIds(harness.db, []);

    expect(result).toEqual({});
    expect(harness.queries).toHaveLength(0);
  });

  it('selects the parent Model3D refs by thumbnailImageId, de-duping the ids', async () => {
    await getModel3DsByThumbnailImageIds(harness.db, [1, 2, 2, 3]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "name", "status", "thumbnailImageId" from "Model3D" ' +
        'where "thumbnailImageId" in ($1, $2, $3)'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([1, 2, 3]);
  });
});

describe('updateModel3D (generic)', () => {
  it('sets provided columns + auto-stamped updatedAt, keyed by id, returning the row', async () => {
    await updateModel3D(harness.db, { id: 42, status: 'Unpublished' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Model3D" set "status" = $1, "updatedAt" = $2 where "id" = $3 returning *'
    );
    expect(parameters).toEqual(['Unpublished', expect.any(Date), 42]);
  });

  it('stamps updatedAt even when only the id is passed', async () => {
    await updateModel3D(harness.db, { id: 7 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('update "Model3D" set "updatedAt" = $1 where "id" = $2 returning *');
    expect(parameters).toEqual([expect.any(Date), 7]);
  });
});

describe('unpublishModel3d', () => {
  it('flips status to Unpublished, keyed by id, skipping a deleted row', async () => {
    await unpublishModel3d(harness.db, { id: 42, userId: 99 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Model3D" set "status" = $1, "updatedAt" = $2 where "id" = $3 and "deletedAt" is null'
    );
    expect(parameters).toEqual(['Unpublished', expect.any(Date), 42]);
  });
});

describe('deleteModel3D', () => {
  it('soft-deletes: Deleted + deletedAt/deletedBy + updatedAt, returning the key columns', async () => {
    await deleteModel3D(harness.db, { id: 42, userId: 99 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Model3D" set "status" = $1, "deletedAt" = $2, "deletedBy" = $3, "updatedAt" = $4 ' +
        'where "id" = $5 returning "id", "status", "deletedAt", "deletedBy"'
    );
    expect(parameters).toEqual(['Deleted', expect.any(Date), 99, expect.any(Date), 42]);
  });
});

describe('restoreModel3D', () => {
  it('Deleted → Unpublished clears deletedAt/deletedBy', async () => {
    await restoreModel3D(harness.db, { id: 7, status: 'Deleted' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Model3D" set "status" = $1, "deletedAt" = $2, "deletedBy" = $3, "updatedAt" = $4 ' +
        'where "id" = $5'
    );
    expect(parameters).toEqual(['Unpublished', null, null, expect.any(Date), 7]);
  });

  it('Unpublished → Published stamps publishedAt', async () => {
    await restoreModel3D(harness.db, { id: 7, status: 'Unpublished' });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Model3D" set "status" = $1, "publishedAt" = $2, "updatedAt" = $3 where "id" = $4'
    );
    expect(parameters).toEqual(['Published', expect.any(Date), expect.any(Date), 7]);
  });
});

describe('setModel3DNsfwLevel', () => {
  it('setModel3DNsfwLevelRow writes nsfwLevel + lockedProperties + updatedAt', async () => {
    await setModel3DNsfwLevelRow(harness.db, {
      id: 7,
      nsfwLevel: 4,
      lockedProperties: ['nsfwLevel'],
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Model3D" set "nsfwLevel" = $1, "lockedProperties" = $2, "updatedAt" = $3 where "id" = $4'
    );
    expect(parameters).toEqual([4, ['nsfwLevel'], expect.any(Date), 7]);
  });

  it('setModel3DMetricNsfwLevel writes the denormalized metric copy only', async () => {
    await setModel3DMetricNsfwLevel(harness.db, { model3dId: 7, nsfwLevel: 4 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('update "Model3DMetric" set "nsfwLevel" = $1 where "model3dId" = $2');
    expect(parameters).toEqual([4, 7]);
  });

  it('compose runs both the row + metric updates in one transaction', async () => {
    await setModel3DNsfwLevel(harness.db, { id: 7, nsfwLevel: 4, lockedProperties: [] });

    const statements = harness.queries.map((q) => q.sql);
    expect(statements.some((s) => s.startsWith('update "Model3D" set "nsfwLevel"'))).toBe(true);
    expect(statements.some((s) => s.startsWith('update "Model3DMetric"'))).toBe(true);
  });
});

describe('toggleModel3DFlag', () => {
  it('sets the chosen boolean flag + resolved lockedProperties + updatedAt', async () => {
    await toggleModel3DFlag(harness.db, {
      id: 7,
      field: 'tosViolation',
      value: true,
      lockedProperties: ['tosViolation'],
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "Model3D" set "lockedProperties" = $1, "tosViolation" = $2, "updatedAt" = $3 where "id" = $4'
    );
    expect(parameters).toEqual([['tosViolation'], true, expect.any(Date), 7]);
  });
});

describe('updateModel3DNsfwLevels', () => {
  it('short-circuits an empty id list WITHOUT running a query (no IN ())', async () => {
    await updateModel3DNsfwLevels(harness.db, []);
    expect(harness.queries).toHaveLength(0);
  });

  it('recomputes from the thumbnail image for the given ids, guarding locked rows', async () => {
    await updateModel3DNsfwLevels(harness.db, [1, 2]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('WITH level AS');
    expect(sql).toContain('m.id IN ($1, $2)');
    expect(sql).toContain(`NOT ('nsfwLevel' = ANY(m."lockedProperties"))`);
    expect(sql).toContain('UPDATE "Model3DMetric" mm');
    expect(sql).not.toContain('IN ()');
    expect(parameters).toEqual([1, 2]);
  });
});

describe('updateModel3DNsfwLevelForThumbnailImage', () => {
  it('scopes the recompute directly on thumbnailImageId', async () => {
    await updateModel3DNsfwLevelForThumbnailImage(harness.db, 555);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain('m."thumbnailImageId" = $1');
    expect(sql).toContain('UPDATE "Model3DMetric" mm');
    expect(parameters).toEqual([555]);
  });
});
