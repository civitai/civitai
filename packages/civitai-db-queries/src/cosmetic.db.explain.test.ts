import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getPaginatedCosmetics,
  grantCosmeticsToUsers,
  insertUserCosmeticGrant,
} from './cosmetic.db';
import { explainHarness } from './test/harness';

// DB-backed tier: EXPLAIN (no ANALYZE) each ported query against the live schema — validates that the
// columns/joins/types resolve against the real database without executing the statement (safe for the write
// below). Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('cosmetics queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());
  beforeEach(() => {
    h.queries.length = 0;
  });

  it('getPaginatedCosmetics (count + items, with filters) plans against the real schema', async () => {
    await getPaginatedCosmetics(h.db, { name: 'a', types: ['Badge'], limit: 20 });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('getPaginatedCosmetics (no filters) plans against the real schema', async () => {
    await getPaginatedCosmetics(h.db, {});
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('insertUserCosmeticGrant plans (write, not executed)', async () => {
    await insertUserCosmeticGrant(h.db, { userId: -1, cosmeticIds: [-1, -2] });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('grantCosmeticsToUsers existence-check select plans against the real schema', async () => {
    // The offline builder returns no rows, so grant throws at validation; the captured existence-check
    // select is what we EXPLAIN against the real schema.
    await grantCosmeticsToUsers(h.db, { cosmeticIds: [-1], userIds: [-1] }).catch(() => undefined);
    const plans = await h.explainAll();
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });
});
