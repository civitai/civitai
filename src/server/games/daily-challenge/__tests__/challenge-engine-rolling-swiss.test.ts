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
const logToAxiom = vi.fn(() => Promise.resolve());
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
    if (sql.includes('COUNT(*)')) return Promise.resolve([{ relations: 0n }]);
    return Promise.resolve(
      Array.from({ length: imageCount }, (_, i) => ({
        id: i + 1,
        url: `uuid-${i + 1}`,
        nsfwLevel: 1,
      }))
    );
  });
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
