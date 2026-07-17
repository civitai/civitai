import { beforeEach, describe, expect, it } from 'vitest';
import {
  getEntityModerationWithImageNsfwLevel,
  recordEntityModerationFailure,
  recordEntityModerationSuccess,
  upsertEntityModerationPending,
} from './entity-moderation.db';
import { compileHarness } from './test/harness';

const h = compileHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe('upsertEntityModerationPending', () => {
  it('inserts a pending row and on conflict resets the verdict to pending', async () => {
    await upsertEntityModerationPending(h.db, {
      entityType: 'article',
      entityId: 5,
      workflowId: 'wf-1',
      contentHash: 'abc',
    });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toContain('insert into "EntityModeration"');
    expect(sql).toContain('on conflict ("entityType", "entityId") do update set');
    // verdict fields reset on conflict
    expect(sql).toContain('"blocked" = ');
    expect(sql).toContain('"triggeredLabels" = ');
    expect(sql).toContain(`"result" = 'null'::jsonb`);
    expect(sql).toContain('returning *');
    // insert values include the explicit updatedAt (Prisma @updatedAt, no trigger)
    expect(parameters).toContain('article');
    expect(parameters).toContain('wf-1');
    expect(parameters).toContain('abc');
    expect(parameters).toContain('Pending');
    expect(parameters.some((p) => p instanceof Date)).toBe(true);
  });

  it('passes null contentHash when omitted', async () => {
    await upsertEntityModerationPending(h.db, {
      entityType: 'article',
      entityId: 5,
      workflowId: null,
    });
    const { parameters } = h.lastQuery();
    expect(parameters).toContain(null);
  });
});

describe('recordEntityModerationSuccess', () => {
  it('updates the row guarded by matching workflowId, setting the verdict', async () => {
    await recordEntityModerationSuccess(h.db, {
      entityType: 'article',
      entityId: 5,
      workflowId: 'wf-1',
      blocked: true,
      triggeredLabels: ['a', 'b'],
      result: { blocked: true },
    });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'update "EntityModeration" set "status" = $1, "blocked" = $2, ' +
        '"triggeredLabels" = $3, "result" = $4::jsonb, "updatedAt" = $5 ' +
        'where "entityType" = $6 and "entityId" = $7 and "workflowId" = $8'
    );
    expect(parameters[0]).toBe('Succeeded');
    expect(parameters[1]).toBe(true);
    expect(parameters[3]).toBe(JSON.stringify({ blocked: true }));
    expect(parameters[5]).toBe('article');
    expect(parameters[6]).toBe(5);
    expect(parameters[7]).toBe('wf-1');
  });
});

describe('recordEntityModerationFailure', () => {
  it('sets the terminal status and increments retryCount, guarded by workflowId', async () => {
    await recordEntityModerationFailure(h.db, {
      entityType: 'article',
      entityId: 5,
      workflowId: 'wf-1',
      status: 'Failed',
    });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toBe(
      'update "EntityModeration" set "status" = $1, ' +
        '"retryCount" = "retryCount" + 1, "updatedAt" = $2 ' +
        'where "entityType" = $3 and "entityId" = $4 and "workflowId" = $5'
    );
    expect(parameters[0]).toBe('Failed');
    expect(parameters[2]).toBe('article');
    expect(parameters[3]).toBe(5);
    expect(parameters[4]).toBe('wf-1');
  });
});

describe('getEntityModerationWithImageNsfwLevel', () => {
  it('joins EntityModeration -> ImageConnection -> Image and aggregates max nsfwLevel', async () => {
    await getEntityModerationWithImageNsfwLevel(h.db, { entityType: 'article', entityId: 5 });
    const { sql, parameters } = h.lastQuery();

    expect(sql).toContain('FROM "EntityModeration" em');
    expect(sql).toContain('LEFT JOIN "ImageConnection" ic');
    expect(sql).toContain('LEFT JOIN "Image" i ON i.id = ic."imageId"');
    expect(sql).toContain('COALESCE(MAX(i."nsfwLevel"), 0) AS "imageNsfwLevel"');
    expect(sql).toContain('GROUP BY em.id');
    expect(parameters).toEqual(['article', 5]);
  });
});
