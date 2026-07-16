import { beforeEach, describe, expect, it } from 'vitest';
import { getModel3DsByThumbnailImageIds, unpublishModel3d } from './model3d.db';
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

describe('unpublishModel3d', () => {
  it('flips status to Unpublished, keyed by id, skipping a deleted row', async () => {
    await unpublishModel3d(harness.db, { id: 42, userId: 99 });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('update "Model3D" set "status" = $1 where "id" = $2 and "deletedAt" is null');
    expect(parameters).toEqual(['Unpublished', 42]);
  });
});
