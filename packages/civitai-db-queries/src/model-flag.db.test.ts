import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearModelPublishedPosts,
  getFlaggedModels,
  getModelForVersion,
  resolveFlaggedModel,
  setModelUnpublished,
  unpublishModelVersions,
  upsertModelFlag,
} from './model-flag.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('upsertModelFlag', () => {
  it('returns null WITHOUT a query when nothing is flagged', async () => {
    const result = await upsertModelFlag(h.db, {
      modelId: 1,
      scanResult: {
        poi: false,
        nsfw: false,
        minor: false,
        triggerWords: false,
        poiName: false,
        sfwOnly: false,
      },
    });
    expect(result).toBeNull();
    expect(h.queries).toHaveLength(0);
  });

  it('upserts on modelId conflict, setting every scanned column, returning the row', async () => {
    await upsertModelFlag(h.db, {
      modelId: 42,
      scanResult: {
        poi: true,
        nsfw: false,
        minor: false,
        triggerWords: true,
        poiName: false,
        sfwOnly: true,
      },
      details: { llm: 'x' },
    }).catch(() => {});
    const { sql, parameters } = h.lastQuery();

    expect(sql).toContain(
      'insert into "ModelFlag" ("modelId", "poi", "nsfw", "minor", "triggerWords", "poiName", "status", "details")'
    );
    expect(sql).toContain('on conflict ("modelId") do update set');
    expect(sql).toContain('"poi" = "excluded"."poi"');
    expect(sql).toContain('"details" = "excluded"."details"');
    expect(sql).toContain('returning *');
    expect(parameters[0]).toBe(42); // modelId
    expect(parameters[1]).toBe(true); // poi
    expect(parameters[6]).toBe('Pending'); // status
    expect(parameters[7]).toBe(JSON.stringify({ llm: 'x' })); // details jsonb
  });

  it('writes a null details when none provided', async () => {
    await upsertModelFlag(h.db, {
      modelId: 7,
      scanResult: {
        poi: false,
        nsfw: true,
        minor: false,
        triggerWords: false,
        poiName: false,
      },
    }).catch(() => {});
    const { sql } = h.lastQuery();
    expect(sql).toContain('insert into "ModelFlag"');
    expect(sql).not.toContain('::jsonb');
  });
});

describe('getFlaggedModels', () => {
  it('selects Pending flags with the nested model, newest-first, with limit/offset', async () => {
    await getFlaggedModels(h.db, { take: 10, skip: 20 });
    // getFlaggedModels runs the items query then the count; the count is last.
    const itemsQuery = h.queries[0];

    expect(itemsQuery.sql).toContain('from "ModelFlag"');
    expect(itemsQuery.sql).toContain('"ModelFlag"."status" = $1');
    expect(itemsQuery.sql).toContain('(select to_json(');
    expect(itemsQuery.sql).toContain('from "Model"');
    expect(itemsQuery.sql).toContain('order by "ModelFlag"."createdAt" desc');
    expect(itemsQuery.sql).toContain('limit');
    expect(itemsQuery.sql).toContain('offset');
    expect(itemsQuery.parameters).toContain('Pending');

    const countQuery = h.queries[1];
    expect(countQuery.sql).toContain('count(*)');
    expect(countQuery.sql).toContain('"status" = $1');
  });

  it('applies caller sort columns before the createdAt tiebreak', async () => {
    await getFlaggedModels(h.db, { sort: [{ id: 'createdAt', desc: false }] });
    const itemsQuery = h.queries[0];
    expect(itemsQuery.sql).toContain('order by "createdAt" asc, "ModelFlag"."createdAt" desc');
  });
});

describe('resolveFlaggedModel', () => {
  it('short-circuits an empty id list without a query', async () => {
    const result = await resolveFlaggedModel(h.db, []);
    expect(result).toEqual([]);
    expect(h.queries).toHaveLength(0);
  });

  it('bulk-resolves the given model ids in one statement', async () => {
    await resolveFlaggedModel(h.db, [1, 2, 3]);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toBe('update "ModelFlag" set "status" = $1 where "modelId" in ($2, $3, $4)');
    expect(parameters).toEqual(['Resolved', 1, 2, 3]);
  });
});

describe('unpublish core statements', () => {
  it('getModelForVersion joins Model to the version', async () => {
    await getModelForVersion(h.db, 5);
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('from "ModelVersion"');
    expect(sql).toContain('inner join "Model" on "Model"."id" = "ModelVersion"."modelId"');
    expect(sql).toContain('"ModelVersion"."id" = $1');
    expect(parameters).toEqual([5]);
  });

  it('setModelUnpublished sets status/meta/updatedAt explicitly, returning userId', async () => {
    await setModelUnpublished(h.db, {
      id: 9,
      status: 'UnpublishedViolation',
      meta: { unpublishedBy: -1 },
    }).catch(() => {});
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('update "Model" set');
    expect(sql).toContain('"status" = $1');
    expect(sql).toContain('::jsonb');
    expect(sql).toContain('"updatedAt" =');
    expect(sql).toContain('returning "userId"');
    expect(parameters[0]).toBe('UnpublishedViolation');
    expect(parameters[parameters.length - 1]).toBe(9);
  });

  it('unpublishModelVersions cascades only Published/Scheduled versions', async () => {
    await unpublishModelVersions(h.db, { modelId: 9, meta: {} });
    const { sql, parameters } = h.lastQuery();
    expect(sql).toContain('update "ModelVersion" set');
    expect(sql).toContain('"status" = $1');
    expect(sql).toContain('"modelId" = ');
    expect(sql).toContain('"status" in ($');
    expect(parameters).toContain('Unpublished');
    expect(parameters).toContain('Published');
    expect(parameters).toContain('Scheduled');
  });

  it('clearModelPublishedPosts nulls publishedAt for the owner via a version subquery', async () => {
    await clearModelPublishedPosts(h.db, {
      modelId: 9,
      userId: 3,
      unpublishedAt: '2026-01-01T00:00:00.000Z',
      unpublishedBy: -1,
    });
    const { sql } = h.lastQuery();
    expect(sql).toContain('update "Post" set');
    expect(sql).toContain('jsonb_build_object');
    expect(sql).toContain('"publishedAt" = ');
    expect(sql).toContain('"publishedAt" is not null');
    expect(sql).toContain('"modelVersionId" in (select "id" from "ModelVersion"');
  });
});
