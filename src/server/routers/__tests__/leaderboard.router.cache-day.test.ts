import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Importing the real router reaches `~/env/client`, which throws at load on a miss.
vi.mock('~/env/client', () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_CIVITAI_LINK: 'http://localhost:3000',
  },
  formatErrors: () => [],
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { leaderboardRouter } from '~/server/routers/leaderboard.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * The client sends no `date`, and `cacheIt` keys on the input, so without a day in the input
 * the Redis key had none either. A board computed just before midnight and written just after
 * the midnight purge was then served as "today" for the whole next day: a tester's list showed
 * 11-11's #37 while their badge showed 11-12's #33. The key must change when the board day does.
 */
type Middleware = (opts: Record<string, unknown>) => Promise<unknown>;
const procedures = (
  leaderboardRouter as unknown as {
    _def: { procedures: Record<string, { _def: { middlewares: Middleware[] } }> };
  }
)._def.procedures;

const CASES = [
  ['getLeaderboard', { id: 'images-funny' }],
  ['getLeaderboardPositions', { userId: 1, top: 1000 }],
  ['getLeadboardLegends', { id: 'images-funny' }],
] as const;

/** Runs the whole chain at `now` and returns the Redis key it read, plus the service input. */
async function run(procedure: string, rawInput: object, now: string) {
  vi.setSystemTime(new Date(now));
  redisMock.redis.packed.get.mockClear();
  redisMock.redis.packed.get.mockResolvedValue(null);
  const input = { ...rawInput };
  const middlewares = procedures[procedure]._def.middlewares;
  let i = 0;
  const step = async (ctx: unknown): Promise<unknown> => {
    if (i >= middlewares.length) return { ok: true, data: {}, ctx };
    return middlewares[i++]({
      input,
      ctx,
      path: `leaderboard.${procedure}`,
      getRawInput: async () => input,
      type: 'query',
      next: (o?: { ctx?: object }) => step(o?.ctx ? { ...(ctx as object), ...o.ctx } : ctx),
    });
  };
  await step({
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    cache: { browserTTL: 0, edgeTTL: 0, staleWhileRevalidate: 0, canCache: false, skip: false },
    features: {},
  });
  const key = redisMock.redis.packed.get.mock.calls
    .map((c) => c[0] as string)
    .find((k) => k.includes(`:leaderboard:${procedure}:`));
  return { key, input: input as { date?: Date } };
}

describe.each(CASES)('%s cache day', (procedure, rawInput) => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('keys a new entry once the UTC day turns', async () => {
    const before = await run(procedure, rawInput, '2026-11-11T23:59:00Z');
    const after = await run(procedure, rawInput, '2026-11-12T00:01:00Z');

    expect(before.key).toBeDefined();
    expect(after.key).not.toBe(before.key);
  });

  it('shares one entry within a UTC day', async () => {
    const early = await run(procedure, rawInput, '2026-11-12T00:01:00Z');
    const late = await run(procedure, rawInput, '2026-11-12T23:59:00Z');

    expect(early.key).toBeDefined();
    expect(late.key).toBe(early.key);
    expect(late.input.date?.toISOString()).toBe('2026-11-12T00:00:00.000Z');
  });
});
