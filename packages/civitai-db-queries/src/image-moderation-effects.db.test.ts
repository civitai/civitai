import { beforeEach, describe, expect, it } from 'vitest';
import {
  getImageTosViolationReport,
  listComicProjectIdsForImages,
  listImageResourceModelVersions,
  listImageTagNames,
  listPostGalleryLinks,
} from './image-moderation-effects.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('listComicProjectIdsForImages', () => {
  it('short-circuits on an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await listComicProjectIdsForImages(harness.db, []);
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('selects distinct projectId for the given images', async () => {
    await listComicProjectIdsForImages(harness.db, [1, 2, 3]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select distinct "projectId" from "ComicPanel" where "imageId" in ($1, $2, $3)'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([1, 2, 3]);
  });
});

describe('listPostGalleryLinks', () => {
  it('short-circuits on an empty id list WITHOUT running a query (no IN ())', async () => {
    const result = await listPostGalleryLinks(harness.db, []);
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('short-circuits when every id is null/undefined (filtered out before the guard)', async () => {
    const result = await listPostGalleryLinks(harness.db, [
      null as unknown as number,
      undefined as unknown as number,
    ]);
    expect(result).toEqual([]);
    expect(harness.queries).toHaveLength(0);
  });

  it('dedupes ids and joins ModelVersion for the gallery links', async () => {
    await listPostGalleryLinks(harness.db, [10, 10, 20]);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "p"."modelVersionId" as "modelVersionId", "mv"."modelId" as "modelId", ' +
        '"p"."model3dId" as "model3dId" from "Post" as "p" ' +
        'left join "ModelVersion" as "mv" on "mv"."id" = "p"."modelVersionId" ' +
        'where "p"."id" in ($1, $2)'
    );
    expect(sql).not.toContain('in ()');
    expect(parameters).toEqual([10, 20]);
  });
});

describe('listImageTagNames', () => {
  it('joins Tag and filters to active tags on the image', async () => {
    await listImageTagNames(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "t"."name" from "TagsOnImageDetails" as "toi" ' +
        'inner join "Tag" as "t" on "t"."id" = "toi"."tagId" ' +
        'where "toi"."imageId" = $1 and "toi"."disabled" = $2'
    );
    expect(parameters).toEqual([42, false]);
  });
});

describe('listImageResourceModelVersions', () => {
  it('selects the modelVersionId of each image resource', async () => {
    await listImageResourceModelVersions(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('select "modelVersionId" from "ImageResourceNew" where "imageId" = $1');
    expect(parameters).toEqual([42]);
  });
});

describe('getImageTosViolationReport', () => {
  it('reads the latest TOS-violation report detail via jsonb ->> accessors', async () => {
    await getImageTosViolationReport(harness.db, 42);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toContain(`r.details->>'violation'`);
    expect(sql).toContain(`r.details->>'comment'`);
    expect(sql).toContain('JOIN "ImageReport" ir ON ir."reportId" = r.id');
    expect(sql).toContain(`r.reason = 'TOSViolation'`);
    expect(sql).toContain('ORDER BY r."createdAt" DESC');
    expect(sql).toContain('LIMIT 1');
    expect(parameters).toEqual([42]);
  });
});
