import { beforeEach, describe, expect, it } from 'vitest';
import { recordModActivity } from './mod-activity.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('recordModActivity', () => {
  it('upserts on (entityType, activity, entityId), refreshing createdAt + userId on conflict', async () => {
    await recordModActivity(harness.db, {
      userId: 99,
      entityType: 'image',
      entityId: 7,
      activity: 'review',
    });
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'insert into "ModActivity" ("userId", "entityType", "entityId", "activity") values ($1, $2, $3, $4) ' +
        'on conflict ("entityType", "activity", "entityId") do update set "createdAt" = now(), "userId" = $5'
    );
    // insert values: userId, entityType, entityId, activity — then the conflict userId.
    expect(parameters).toEqual([99, 'image', 7, 'review', 99]);
  });

  it('emits the now() refresh as raw SQL, not a bound parameter', async () => {
    await recordModActivity(harness.db, {
      userId: 1,
      entityType: 'model',
      entityId: 2,
      activity: 'delete',
    });
    const { sql } = harness.lastQuery();

    expect(sql).toContain('"createdAt" = now()');
    expect(sql).not.toContain('$6');
  });
});
