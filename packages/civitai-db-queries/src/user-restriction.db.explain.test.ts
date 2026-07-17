import { afterAll, describe, expect, it } from 'vitest';
import {
  createUserRestriction,
  getPromptAllowlist,
  getUserRestrictionById,
  getUserRestrictions,
  getUserRestrictionsForBackfill,
  setUserRestrictionStatus,
  setUserRestrictionTriggers,
  updateUserRestriction,
  upsertPromptAllowlistEntry,
} from './user-restriction.db';
import { explainHarness } from './test/harness';

// DB-backed tier: pass the harness's compile-only `db` to each query (so writes compile without executing),
// then EXPLAIN (no ANALYZE) the compiled SQL against the live schema — validates columns/joins/types resolve.
// Skips when no DB URL is available (see the harness).
const h = explainHarness();

describe.skipIf(!h.hasDb)('user-restriction queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('getUserRestrictions (count + items) plans against the real schema', async () => {
    await getUserRestrictions(h.db, {
      page: 1,
      limit: 20,
      status: 'Pending',
      username: 'x',
      userId: 1,
    });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('getUserRestrictionById plans', async () => {
    await getUserRestrictionById(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('updateUserRestriction plans (write, not executed)', async () => {
    await updateUserRestriction(h.db, { id: -1, status: 'Upheld' });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setUserRestrictionStatus plans (write, not executed)', async () => {
    await setUserRestrictionStatus(h.db, {
      id: -1,
      status: 'Upheld',
      resolvedBy: -1,
      resolvedMessage: 'x',
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setUserRestrictionTriggers plans (write, not executed)', async () => {
    await setUserRestrictionTriggers(h.db, { id: -1, triggers: [{ prompt: 'x' }] });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getUserRestrictionsForBackfill plans', async () => {
    await getUserRestrictionsForBackfill(h.db, { id: -1, limit: 5 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('createUserRestriction plans (write, not executed)', async () => {
    await createUserRestriction(h.db, { userId: -1, triggers: [{ prompt: 'x' }] });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('upsertPromptAllowlistEntry plans (write, not executed)', async () => {
    await upsertPromptAllowlistEntry(h.db, {
      trigger: 'x',
      category: 'y',
      addedBy: -1,
      reason: 'z',
      userRestrictionId: -1,
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getPromptAllowlist plans', async () => {
    await getPromptAllowlist(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
