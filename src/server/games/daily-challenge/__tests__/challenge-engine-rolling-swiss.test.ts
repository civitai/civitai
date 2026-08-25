import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PairwiseModule from '~/server/games/daily-challenge/challenge-pairwise';
import type * as StoreModule from '~/server/games/daily-challenge/challenge-pairwise-store';
import type * as HelpersModule from '~/server/games/daily-challenge/challenge-helpers';

const compareGroup = vi.fn();
const recordComparison = vi.fn();
const replaceStandings = vi.fn();
const getStandings = vi.fn();
const getSwissState = vi.fn();
const incrementOperationSpent = vi.fn();
const operationBudgetRemaining = vi.fn();
const logToAxiom = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
const queryRaw = vi.fn();

// Spread the real modules and override only what this suite drives. Hand-listing exports couples a
// test to the whole transitive import graph, and nothing warns when that graph grows.
vi.mock('~/server/games/daily-challenge/challenge-pairwise', async (importOriginal) => ({
  ...(await importOriginal<typeof PairwiseModule>()),
  compareGroup: (...args: unknown[]) => compareGroup(...args),
}));
vi.mock('~/server/games/daily-challenge/challenge-pairwise-store', async (importOriginal) => ({
  ...(await importOriginal<typeof StoreModule>()),
  getStandings: (...args: unknown[]) => getStandings(...args),
  getSwissState: (...args: unknown[]) => getSwissState(...args),
  recordComparison: (...args: unknown[]) => recordComparison(...args),
  replaceStandings: (...args: unknown[]) => replaceStandings(...args),
}));
vi.mock('~/server/games/daily-challenge/challenge-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof HelpersModule>()),
  incrementOperationSpent: (...args: unknown[]) => incrementOperationSpent(...args),
  operationBudgetRemaining: (...args: unknown[]) => operationBudgetRemaining(...args),
}));
vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
  dbWrite: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...args: unknown[]) => logToAxiom(...args),
}));

import { rollingSwissEngine } from '~/server/games/daily-challenge/challenge-engine-rolling-swiss';
import { GROUP_SIZE, RELATIONS_PER_CALL } from '~/server/games/daily-challenge/challenge-swiss';

const ctx = {
  challengeId: 1,
  collectionId: 2,
  theme: 'Summer Beach Vibes',
  categories: [{ key: 'theme', label: 'Theme', weight: 100 }],
};

const standings = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    imageId: i + 1,
    userId: i + 1,
    rank: i + 1,
    comparisons: 0,
  }));

/** dbRead.$queryRaw serves the challenge clock, then the relation count, then the images. */
function stubQueries(imageCount: number) {
  queryRaw.mockImplementation((strings: TemplateStringsArray) => {
    const sql = Array.isArray(strings) ? strings.join('') : String(strings);
    if (sql.includes('startsAt')) {
      return Promise.resolve([
        { startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000) },
      ]);
    }
    if (sql.includes('COUNT(*)')) return Promise.resolve([{ relations: BigInt(0) }]);
    return Promise.resolve(
      Array.from({ length: imageCount }, (_, i) => ({
        id: i + 1,
        url: `uuid-${i + 1}`,
        nsfwLevel: 1,
      }))
    );
  });
}

/** The `failedGroups` payload of the one `challenge-swiss-group-failed` event a tick emits. */
function failedGroupsFrom(log: typeof logToAxiom): string[] {
  const event = log.mock.calls
    .map(([arg]) => arg as { name: string; failedGroups?: string[] })
    .find((arg) => arg.name === 'challenge-swiss-group-failed');
  return event?.failedGroups ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  operationBudgetRemaining.mockResolvedValue({ remaining: null, spent: 0 });
  getSwissState.mockResolvedValue({ wins: new Map(), games: new Map(), played: new Set() });
  recordComparison.mockResolvedValue(undefined);
  incrementOperationSpent.mockResolvedValue(undefined);
});

describe('advance and rankField', () => {
  it('records every relation a ranked group yields, and bills the call ONCE', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE));
    stubQueries(GROUP_SIZE);
    compareGroup.mockResolvedValue({
      order: [1, 2, 3, 4],
      malformed: false,
      model: 'openai/gpt-5.6-luna',
      usage: {},
      buzzCost: 12,
    });

    const calls = await rollingSwissEngine.advance!(ctx, Date.now() + 60_000);

    expect(calls).toBe(1);
    expect(recordComparison).toHaveBeenCalledTimes(RELATIONS_PER_CALL);

    // 🔴 One CALL produced six rows. Spreading its cost across them makes each look a sixth as
    // expensive; repeating it sextuples the challenge's recorded spend. Exactly one row carries it,
    // and the challenge is incremented by the call's cost, not six times it.
    const billed = recordComparison.mock.calls
      .map(([arg]) => (arg as { verdict: { buzzCost: number } }).verdict.buzzCost)
      .filter((cost) => cost > 0);
    expect(billed).toEqual([12]);
    expect(incrementOperationSpent).toHaveBeenCalledExactlyOnceWith(1, 12);
  });

  it('counts a malformed ranking as a failure and records nothing for it', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE));
    stubQueries(GROUP_SIZE);
    compareGroup.mockResolvedValue({
      order: null,
      malformed: true,
      model: 'openai/gpt-5.6-luna',
      usage: {},
      buzzCost: 12,
    });

    const calls = await rollingSwissEngine.advance!(ctx, Date.now() + 60_000);

    // The call happened and is billed — a ranking we cannot parse is spend we already incurred, not
    // a call that never occurred. It must never be retried into invisibility.
    expect(calls).toBe(1);
    expect(incrementOperationSpent).toHaveBeenCalledExactlyOnceWith(1, 12);
    expect(recordComparison).not.toHaveBeenCalled();
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'challenge-swiss-malformed', type: 'warning', malformed: 1 })
    );
  });

  /**
   * 🔴 What this establishes, and what it does not. `runPool`'s concurrency is 16 and only four
   * groups are planned, so all four are dispatched before any resolves — the rejection is pinned to
   * the second INVOCATION, which is deterministic, but the order in which the other three finish is
   * not, so nothing here asserts an ordering. What it pins is that one provider failure costs one
   * group: the tick still returns, the other three groups still record, and the spend is still
   * billed. Before the per-group catch this threw out of `advance()` — 49 of 133 ticks on
   * challenge 438 did exactly that in production.
   */
  it('loses ONE group to a provider failure, not the tick', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE * 4));
    stubQueries(GROUP_SIZE * 4);
    // The ranking is derived from the group it was ASKED about, as the real one is — a fixed
    // `[1, 2, 3, 4]` would have every group record relations among the same four images, and the
    // attribution assertion below would then be reading the mock rather than the engine.
    let call = 0;
    compareGroup.mockImplementation((input: unknown) => {
      call++;
      if (call === 2) return Promise.reject(new Error('Provider returned error'));
      const { group } = input as { group: { imageId: number }[] };
      return Promise.resolve({
        order: group.map((image) => image.imageId),
        malformed: false,
        model: 'openai/gpt-5.6-luna',
        usage: {},
        buzzCost: 12,
      });
    });

    const calls = await rollingSwissEngine.advance!(ctx, Date.now() + 60_000);

    expect(compareGroup).toHaveBeenCalledTimes(4);
    expect(calls).toBe(3);
    expect(recordComparison).toHaveBeenCalledTimes(3 * RELATIONS_PER_CALL);
    // A tick that threw billed NOTHING for the calls it had already paid the provider for.
    expect(incrementOperationSpent).toHaveBeenCalledExactlyOnceWith(1, 36);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'challenge-swiss-group-failed',
        type: 'warning',
        failed: 1,
        calls: 3,
        // The NEGATIVE arm of the refusal classification. Without it `refused` is pinned in one
        // direction only, and `if (isContentRefusal(error)) refused++` reduced to `refused++` passes.
        refused: 0,
        message: 'Provider returned error',
      })
    );
    expect(logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'challenge-swiss-group-unloadable' })
    );

    // Attribution is the whole point of logging membership, and with four groups "the right group"
    // is a claim that can be wrong. The failed group must be exactly the entries that recorded
    // nothing — logging `groups[0]`, or every planned group, makes the field actively misleading.
    const failedIds = failedGroupsFrom(logToAxiom)[0].split(',').sort();
    const recordedIds = new Set(
      recordComparison.mock.calls.flatMap(([arg]) => {
        const { imageIdA, imageIdB } = (arg as { verdict: { imageIdA: number; imageIdB: number } })
          .verdict;
        return [String(imageIdA), String(imageIdB)];
      })
    );
    expect(failedIds).toHaveLength(GROUP_SIZE);
    expect(failedIds.filter((id) => recordedIds.has(id))).toEqual([]);
  });

  /**
   * The failure mode the fix is NAMED for, which a four-group fixture cannot reach: `runPool`'s
   * concurrency is 16, so with four groups every one is dispatched before any rejection is seen and
   * the old code made the same four calls. Only past the lane count does `runPool`'s `failed` flag
   * have a next item to refuse — 17 groups, a rejection on the first, and group 17 is the one
   * production was losing. 68 standings at the stubbed progress plan 17 groups: `tickCallBudget` is
   * ceil(68*9/2/6)=51 due, halved to 26 by progress, and `planGroups` cuts floor(68/4)=17 from them.
   *
   * The second rejection is not decoration: it is what pins `firstError ??=` as FIRST rather than
   * last, and gives `failedGroups` more than one entry to get wrong.
   */
  it('still dispatches the groups a failure used to abandon', async () => {
    const field = 68;
    getStandings.mockResolvedValue(standings(field));
    stubQueries(field);
    let call = 0;
    compareGroup.mockImplementation(() => {
      call++;
      if (call === 1) return Promise.reject(new Error('first failure'));
      if (call === 5) return Promise.reject(new Error('second failure'));
      return Promise.resolve({
        order: [1, 2, 3, 4],
        malformed: false,
        model: 'openai/gpt-5.6-luna',
        usage: {},
        buzzCost: 12,
      });
    });

    const calls = await rollingSwissEngine.advance!(ctx, Date.now() + 60_000);

    // 17, not 16. Under the old code the 17th group was never dispatched — `runPool` stops taking
    // items once a worker has rejected — and the tick threw on top of it.
    expect(compareGroup).toHaveBeenCalledTimes(17);
    expect(calls).toBe(15);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'challenge-swiss-group-failed',
        planned: 17,
        failed: 2,
        calls: 15,
        message: 'first failure',
      })
    );
    expect(failedGroupsFrom(logToAxiom)).toHaveLength(2);
  });

  /**
   * The catch covers the relation WRITES as well as the comparison. A dropped connection on the
   * write is at least as likely as a provider 5xx, and under the old code it abandoned the tick the
   * same way. The call is still counted and still billed: the provider was already paid.
   */
  it('loses one group to a failed relation write, and still bills the call', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE * 4));
    stubQueries(GROUP_SIZE * 4);
    compareGroup.mockResolvedValue({
      order: [1, 2, 3, 4],
      malformed: false,
      model: 'openai/gpt-5.6-luna',
      usage: {},
      buzzCost: 12,
    });
    recordComparison.mockRejectedValueOnce(new Error('write conflict'));

    await expect(rollingSwissEngine.advance!(ctx, Date.now() + 60_000)).resolves.toBe(4);
    expect(incrementOperationSpent).toHaveBeenCalledExactlyOnceWith(1, 48);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'challenge-swiss-write-failed',
        writeFailed: 1,
        calls: 4,
        message: 'write conflict',
      })
    );
    // A database failure must not be filed as a provider failure. They point at different systems,
    // and `refused` — the count of provider content refusals — must never be fed a Postgres error.
    expect(logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'challenge-swiss-group-failed' })
    );
  });

  it('reports a group skipped for missing images under its OWN name, not as a failure', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE * 4));
    // One image of the sixteen does not load, so exactly one group is short whichever band it lands
    // in. A group we cannot assemble is not a group that failed, and a dashboard that cannot tell a
    // deleted image from a provider outage sends the next reader to the wrong system.
    queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join('') : String(strings);
      if (sql.includes('startsAt'))
        return Promise.resolve([
          { startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000) },
        ]);
      if (sql.includes('COUNT(*)')) return Promise.resolve([{ relations: BigInt(0) }]);
      return Promise.resolve(
        Array.from({ length: GROUP_SIZE * 4 }, (_, i) => ({
          id: i + 1,
          url: `uuid-${i + 1}`,
          nsfwLevel: 1,
        })).filter((row) => row.id !== 7)
      );
    });
    compareGroup.mockResolvedValue({
      order: [1, 2, 3, 4],
      malformed: false,
      model: 'openai/gpt-5.6-luna',
      usage: {},
      buzzCost: 12,
    });

    await expect(rollingSwissEngine.advance!(ctx, Date.now() + 60_000)).resolves.toBe(3);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'challenge-swiss-group-unloadable',
        type: 'warning',
        unloadable: 1,
      })
    );
    expect(logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'challenge-swiss-group-failed' })
    );
  });

  /**
   * The envelope message is generic for BOTH a refusal and a 5xx — production shows 49 identical
   * `Provider returned error` lines and nothing to tell them apart. `isContentRefusal` reads the raw
   * body, so the counter answers "why" where the message cannot. Nothing acts on it: excluding an
   * entry is Justin's call and he chose not to, on the grounds that a transient provider error would
   * silently drop a legitimate creator's entry.
   */
  it('classifies a content refusal apart from any other provider failure', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE));
    stubQueries(GROUP_SIZE);
    const refusal = Object.assign(new Error('Provider returned error'), {
      body: '{"error":{"metadata":{"reasons":["data_inspection_failed"]}}}',
    });
    compareGroup.mockRejectedValue(refusal);

    await expect(rollingSwissEngine.advance!(ctx, Date.now() + 60_000)).resolves.toBe(0);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'challenge-swiss-group-failed',
        failed: 1,
        refused: 1,
      })
    );
    // A group fails as a UNIT, and its membership is what makes attribution possible across ticks.
    // Compared as a set: the entries are logged in PRESENTATION order, which the band shuffle
    // deliberately varies, so asserting the literal order would pin the shuffle rather than the log.
    expect(failedGroupsFrom(logToAxiom)[0].split(',').sort()).toEqual(['1', '2', '3', '4']);
    // Nothing was billed: the provider never returned a usage figure to bill from.
    expect(incrementOperationSpent).not.toHaveBeenCalled();
  });

  // Passes against the UNFIXED engine too — it is not a revert control, it is the third arm of the
  // three-way distinction: success emits neither warning. It fails if either log is ever moved out
  // of its `if`, which is the edit it exists to stop.
  it('reports NEITHER warning on a clean tick', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE));
    stubQueries(GROUP_SIZE);
    compareGroup.mockResolvedValue({
      order: [1, 2, 3, 4],
      malformed: false,
      model: 'openai/gpt-5.6-luna',
      usage: {},
      buzzCost: 12,
    });

    await expect(rollingSwissEngine.advance!(ctx, Date.now() + 60_000)).resolves.toBe(1);
    const names = logToAxiom.mock.calls.map(([arg]) => (arg as { name: string }).name);
    expect(names).not.toContain('challenge-swiss-group-failed');
    expect(names).not.toContain('challenge-swiss-group-unloadable');
  });

  it('does nothing when the field is smaller than one group', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE - 1));
    await expect(rollingSwissEngine.advance!(ctx, Date.now() + 60_000)).resolves.toBe(0);
    expect(compareGroup).not.toHaveBeenCalled();
  });

  it('spends nothing once the deadline has passed', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE * 4));
    stubQueries(GROUP_SIZE * 4);
    await expect(rollingSwissEngine.advance!(ctx, Date.now() - 1)).resolves.toBe(0);
    expect(compareGroup).not.toHaveBeenCalled();
  });

  /**
   * 🔴 This case is why the ceiling is applied at PLAN time. Written first as an in-flight check, it
   * let all 8 planned groups through against a budget of 10 with calls costing 12 — sixteen
   * concurrent lanes all read a spend of zero before any had paid for anything. It printed
   * `expected 8 to be less than 8`, which is what sent me to look at the mechanism.
   */
  it('caps calls to what the remaining budget affords, priced from history', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE * 8));
    // 60 buzz over 5 calls = 12 each; 40 remaining affords 3.
    operationBudgetRemaining.mockResolvedValue({ remaining: 40, spent: 60 });
    queryRaw.mockImplementation((strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join('') : String(strings);
      if (sql.includes('startsAt'))
        return Promise.resolve([
          { startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000) },
        ]);
      if (sql.includes('COUNT(*)'))
        return Promise.resolve([{ relations: BigInt(5 * RELATIONS_PER_CALL) }]);
      return Promise.resolve(
        Array.from({ length: GROUP_SIZE * 8 }, (_, i) => ({
          id: i + 1,
          url: `uuid-${i + 1}`,
          nsfwLevel: 1,
        }))
      );
    });
    compareGroup.mockResolvedValue({
      order: [1, 2, 3, 4],
      malformed: false,
      model: 'openai/gpt-5.6-luna',
      usage: {},
      buzzCost: 12,
    });

    await expect(rollingSwissEngine.advance!(ctx, Date.now() + 60_000)).resolves.toBe(3);
  });

  it('never runs when the budget is already spent, and says so', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE * 4));
    stubQueries(GROUP_SIZE * 4);
    operationBudgetRemaining.mockResolvedValue({ remaining: 0, spent: 500 });

    await expect(rollingSwissEngine.advance!(ctx, Date.now() + 60_000)).resolves.toBe(0);
    expect(compareGroup).not.toHaveBeenCalled();
    // Stopping silently is the failure mode this subsystem is already full of.
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'challenge-swiss-budget-exhausted', type: 'warning' })
    );
  });

  /**
   * 🔴 THE MONEY CASE. Do not relax this into a `break` without reading why it is a `throw`.
   *
   * Per-group catching means a close-time pass where EVERY group fails returns 0 calls, which is
   * the same number a settled field returns. If those two end the loop the same way, `rankField`
   * ranks a field nothing measured: with no comparison rows every entry scores 0.5 in `strength`,
   * so `swissStandings` falls through to its `imageId` tiebreak and the caller pays real prizes on
   * upload order. Before groups were caught individually the provider error propagated and left the
   * challenge in 'Completing' for a later run to judge properly; this keeps that behaviour for the
   * close path only.
   */
  it('REFUSES to finalize a field when every close-time group failed', async () => {
    const field = GROUP_SIZE * 4;
    stubQueries(field);
    compareGroup.mockRejectedValue(new Error('Provider returned error'));

    await expect(
      rollingSwissEngine.rankField(
        ctx,
        Array.from({ length: field }, (_, i) => ({
          imageId: i + 1,
          userId: i + 1,
          username: `u${i}`,
          weightedRating: 0,
        }))
      )
    ).rejects.toThrow(/none succeeded/);

    // No standings written means no ranking for the caller to pay out against.
    expect(replaceStandings).not.toHaveBeenCalled();
  });

  it('still finalizes at close when SOME groups succeeded', async () => {
    const field = GROUP_SIZE * 4;
    stubQueries(field);
    let call = 0;
    compareGroup.mockImplementation((input: unknown) => {
      call++;
      if (call === 2) return Promise.reject(new Error('Provider returned error'));
      const { group } = input as { group: { imageId: number }[] };
      return Promise.resolve({
        order: group.map((image) => image.imageId),
        malformed: false,
        model: 'openai/gpt-5.6-luna',
        usage: {},
        buzzCost: 12,
      });
    });

    // The guard above must not have made close brittle: a partially-failing provider still settles.
    const ranked = await rollingSwissEngine.rankField(
      ctx,
      Array.from({ length: field }, (_, i) => ({
        imageId: i + 1,
        userId: i + 1,
        username: `u${i}`,
        weightedRating: 0,
      }))
    );
    expect(ranked).toHaveLength(field);
    expect(replaceStandings).toHaveBeenCalledTimes(1);
  });

  it('applies the spend ceiling at close too, not only on ticks', async () => {
    // 🔴 The close-time settle was originally unbounded, which made the budget a limit on ticks
    // only — exempting the exact moment a runaway is most likely.
    getStandings.mockResolvedValue(standings(GROUP_SIZE * 8));
    stubQueries(GROUP_SIZE * 8);
    operationBudgetRemaining.mockResolvedValue({ remaining: 0, spent: 500 });

    const ranked = await rollingSwissEngine.rankField(
      ctx,
      Array.from({ length: GROUP_SIZE * 8 }, (_, i) => ({
        imageId: i + 1,
        userId: i + 1,
        username: `u${i}`,
        weightedRating: 0,
      }))
    );

    expect(compareGroup).not.toHaveBeenCalled();
    // It still returns a full ranking from what it already knows — an exhausted budget must not
    // silently shorten the field.
    expect(ranked).toHaveLength(GROUP_SIZE * 8);
    expect(logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'challenge-swiss-budget-exhausted', stage: 'close' })
    );
  });

  it('buys exactly one call to price itself when there is no spend history', async () => {
    getStandings.mockResolvedValue(standings(GROUP_SIZE * 8));
    stubQueries(GROUP_SIZE * 8);
    operationBudgetRemaining.mockResolvedValue({ remaining: 1000, spent: 0 });
    compareGroup.mockResolvedValue({
      order: [1, 2, 3, 4],
      malformed: false,
      model: 'openai/gpt-5.6-luna',
      usage: {},
      buzzCost: 12,
    });

    // A call's price is not knowable in advance, and with no history there is nothing to divide, so
    // it buys one and prices it rather than guessing a constant.
    await expect(rollingSwissEngine.advance!(ctx, Date.now() + 60_000)).resolves.toBe(1);
  });
});
