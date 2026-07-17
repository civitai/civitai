import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  expireStrikes,
  findUserIdByUsername,
  getActiveStrikePoints,
  getActiveStrikePointsForUpdate,
  getStrikeSummary,
  getStrikesForMod,
  getStrikesForUser,
  getUserMuteState,
  getUsersToUnmute,
  getUserStandings,
  insertUserStrike,
  setUserMuteState,
  shouldRateLimitStrike,
  voidStrike,
} from './strike.db';
import { explainHarness } from './test/harness';

// DB-backed tier: pass the compile-only `db` to each query (compiles without executing — safe for the writes
// below), then EXPLAIN (no ANALYZE) the compiled SQL against the live schema. This never runs the statement
// but parses + plans it, so a query whose columns/types/enum casts don't resolve fails here even though the
// compile test passed. Skips when no DB URL is available (see the harness). The escalation transaction is
// covered by EXPLAINing its decomposed leaf statements (getActiveStrikePointsForUpdate / getUserMuteState /
// setUserMuteState) rather than the transaction itself.
const h = explainHarness();

beforeEach(() => {
  h.queries.length = 0;
});

describe.skipIf(!h.hasDb)('strike queries EXPLAIN against the real schema', () => {
  afterAll(() => h.destroy());

  it('shouldRateLimitStrike plans', async () => {
    await shouldRateLimitStrike(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getActiveStrikePoints plans', async () => {
    await getActiveStrikePoints(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getActiveStrikePointsForUpdate plans (FOR UPDATE read)', async () => {
    await getActiveStrikePointsForUpdate(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getStrikeSummary plans', async () => {
    await getStrikeSummary(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getStrikesForUser plans (list + aggregate)', async () => {
    await getStrikesForUser(h.db, { userId: -1, includeInternalNotes: true });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('findUserIdByUsername plans', async () => {
    await findUserIdByUsername(h.db, 'nobody');
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getStrikesForMod plans (count + items)', async () => {
    await getStrikesForMod(h.db, {
      limit: 20,
      page: 1,
      userId: -1,
      status: ['Active'],
      reason: ['TOSViolation'],
    });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('getUserStandings plans (items + count), default INNER JOIN', async () => {
    await getUserStandings(h.db, { limit: 20, page: 1 });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('getUserStandings plans with all filters + LEFT JOIN', async () => {
    await getUserStandings(h.db, {
      limit: 20,
      page: 2,
      userId: -1,
      username: 'nobody',
      isMuted: true,
      isFlaggedForReview: true,
      hasActiveStrikes: true,
      sort: 'lastStrike',
      sortOrder: 'asc',
    });
    const plans = await h.explainAll();
    expect(plans).toHaveLength(2);
    for (const plan of plans) expect(plan.length).toBeGreaterThan(0);
  });

  it('getUserMuteState plans', async () => {
    await getUserMuteState(h.db, -1);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setUserMuteState plans (write with jsonb meta)', async () => {
    await setUserMuteState(h.db, {
      userId: -1,
      muted: true,
      muteExpiresAt: null,
      meta: { strikeFlaggedForReview: true, strikeFlaggedAt: new Date() },
    });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('setUserMuteState plans (write without meta)', async () => {
    await setUserMuteState(h.db, { userId: -1, muted: false, muteExpiresAt: null });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('insertUserStrike plans (write, not executed)', async () => {
    await insertUserStrike(h.db, {
      userId: -1,
      reason: 'ManualModAction',
      points: 1,
      description: 'x',
      expiresAt: new Date(),
    }).catch(() => {});
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('voidStrike plans (atomic status-guarded update; escalation not reached on empty result)', async () => {
    await voidStrike(h.db, { strikeId: -1, voidReason: 'x', voidedBy: -1 });
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('expireStrikes plans (returning update; escalation not reached on empty result)', async () => {
    await expireStrikes(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });

  it('getUsersToUnmute plans', async () => {
    await getUsersToUnmute(h.db);
    expect((await h.explainLast()).length).toBeGreaterThan(0);
  });
});
