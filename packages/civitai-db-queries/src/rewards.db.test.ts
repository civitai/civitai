import { beforeEach, describe, expect, it } from 'vitest';
import {
  deleteRewardsBonusEvent,
  getActiveRewardsBonusEvent,
  getGlobalRewardsBonus,
  getRewardsBonusEventById,
  getRewardsBonusEventsPaged,
  upsertRewardsBonusEvent,
} from './rewards.db';
import { compileHarness } from './test/harness';

const harness = compileHarness();

beforeEach(() => {
  harness.queries.length = 0;
});

describe('getGlobalRewardsBonus', () => {
  it('reads enabled RewardsBonusEvent rows (multiplier + window), filtering by enabled', async () => {
    await getGlobalRewardsBonus(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "multiplier", "startsAt", "endsAt" from "RewardsBonusEvent" where "enabled" = $1'
    );
    expect(parameters).toEqual([true]);
  });

  it('runs exactly one query (no ClickHouse/redis side-effects ported)', async () => {
    await getGlobalRewardsBonus(harness.db);
    expect(harness.queries).toHaveLength(1);
  });
});

describe('getActiveRewardsBonusEvent', () => {
  it('reads enabled events ordered by multiplier then createdAt (window filtered in JS)', async () => {
    await getActiveRewardsBonusEvent(harness.db);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "name", "description", "multiplier", "articleId", "bannerLabel", ' +
        '"startsAt", "endsAt" from "RewardsBonusEvent" where "enabled" = $1 ' +
        'order by "multiplier" desc, "createdAt" desc'
    );
    expect(parameters).toEqual([true]);
    expect(harness.queries).toHaveLength(1);
  });
});

describe('upsertRewardsBonusEvent', () => {
  it('inserts a new event (no id), stamping createdById and updatedAt', async () => {
    await upsertRewardsBonusEvent(harness.db, {
      name: 'Event',
      multiplier: 20,
      enabled: true,
      userId: 7,
    }).catch(() => {});
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'insert into "RewardsBonusEvent" ' +
        '("name", "description", "multiplier", "articleId", "bannerLabel", "enabled", ' +
        '"startsAt", "endsAt", "createdById", "updatedAt") ' +
        'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *'
    );
    expect(parameters[0]).toBe('Event');
    expect(parameters[1]).toBeNull(); // description defaulted
    expect(parameters[2]).toBe(20);
    expect(parameters[8]).toBe(7); // createdById
    expect(parameters[9]).toBeInstanceOf(Date); // updatedAt stamped, not left to a trigger
  });

  it('updates an existing event (id) stamping updatedAt, not createdById', async () => {
    await upsertRewardsBonusEvent(harness.db, {
      id: 5,
      name: 'Event',
      multiplier: 30,
      enabled: false,
      userId: 7,
    }).catch(() => {});
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'update "RewardsBonusEvent" set ' +
        '"name" = $1, "description" = $2, "multiplier" = $3, "articleId" = $4, ' +
        '"bannerLabel" = $5, "enabled" = $6, "startsAt" = $7, "endsAt" = $8, "updatedAt" = $9 ' +
        'where "id" = $10 returning *'
    );
    expect(sql).not.toContain('createdById');
    expect(parameters[8]).toBeInstanceOf(Date); // updatedAt
    expect(parameters[9]).toBe(5); // id
  });
});

describe('deleteRewardsBonusEvent', () => {
  it('deletes by id', async () => {
    await deleteRewardsBonusEvent(harness.db, 9);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe('delete from "RewardsBonusEvent" where "id" = $1');
    expect(parameters).toEqual([9]);
  });
});

describe('getRewardsBonusEventById', () => {
  it('selects the full event row by id', async () => {
    await getRewardsBonusEventById(harness.db, 3);
    const { sql, parameters } = harness.lastQuery();

    expect(sql).toBe(
      'select "id", "name", "description", "multiplier", "articleId", "bannerLabel", ' +
        '"enabled", "startsAt", "endsAt", "createdAt", "updatedAt" ' +
        'from "RewardsBonusEvent" where "id" = $1'
    );
    expect(parameters).toEqual([3]);
  });
});

describe('getRewardsBonusEventsPaged', () => {
  it('pages ordered by enabled desc, startsAt desc nulls last, id desc, plus a count', async () => {
    await getRewardsBonusEventsPaged(harness.db, { page: 2, limit: 10 });

    expect(harness.queries).toHaveLength(2);
    const page = harness.queries[0];
    expect(page.sql).toBe(
      'select "id", "name", "description", "multiplier", "articleId", "bannerLabel", ' +
        '"enabled", "startsAt", "endsAt", "createdAt", "updatedAt" from "RewardsBonusEvent" ' +
        'order by "enabled" desc, "startsAt" desc nulls last, "id" desc limit $1 offset $2'
    );
    expect(page.parameters).toEqual([10, 10]); // take, skip = (page-1)*take

    const count = harness.queries[1];
    expect(count.sql).toBe('select count(*) as "count" from "RewardsBonusEvent"');
  });

  it('omits the offset when no page is given (skip undefined)', async () => {
    await getRewardsBonusEventsPaged(harness.db, { limit: 10 });
    expect(harness.queries[0].sql).toContain('limit $1');
    expect(harness.queries[0].sql).not.toContain('offset');
    expect(harness.queries[0].parameters).toEqual([10]);
  });
});
