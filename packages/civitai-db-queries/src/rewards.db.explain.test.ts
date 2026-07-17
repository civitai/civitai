import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteRewardsBonusEvent,
  getActiveRewardsBonusEvent,
  getGlobalRewardsBonus,
  getRewardsBonusEventById,
  getRewardsBonusEventsPaged,
  upsertRewardsBonusEvent,
} from './rewards.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) the ported read against the live schema — parses + plans it without
// executing, so a query whose columns/types don't resolve against the real database fails here even though
// the compile-only test passed. Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('rewards queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getGlobalRewardsBonus plans against the real schema', async () => {
    await getGlobalRewardsBonus(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getActiveRewardsBonusEvent plans against the real schema', async () => {
    await getActiveRewardsBonusEvent(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('upsertRewardsBonusEvent insert path plans (write, not executed)', async () => {
    await upsertRewardsBonusEvent(h.db, {
      name: 'Event',
      multiplier: 20,
      enabled: true,
      userId: -1,
    }).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('upsertRewardsBonusEvent update path plans (write, not executed)', async () => {
    await upsertRewardsBonusEvent(h.db, {
      id: -1,
      name: 'Event',
      multiplier: 30,
      enabled: false,
      userId: -1,
    }).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('deleteRewardsBonusEvent plans (write, not executed)', async () => {
    await deleteRewardsBonusEvent(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getRewardsBonusEventById plans against the real schema', async () => {
    await getRewardsBonusEventById(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getRewardsBonusEventsPaged plans both the page and count queries', async () => {
    h.queries.length = 0;
    await getRewardsBonusEventsPaged(h.db, { page: 1, limit: 10 });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });
});
