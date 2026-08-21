import { beforeAll, describe, expect, it } from 'vitest';

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { leaderboardRouter } from '~/server/routers/leaderboard.router';

/**
 * These procedures resolve `isModerator` from ctx and hand it to the service,
 * which uses it to widen the board set. Their inputs cannot express that, so the
 * key has to carry it separately.
 */
type Middleware = (opts: {
  input?: unknown;
  ctx: unknown;
  next: () => unknown;
  path: string;
}) => Promise<unknown>;

const redisFake = redisMock.redis;

const proceduresOf = (
  leaderboardRouter as unknown as {
    _def: { procedures: Record<string, { _def: { middlewares: Middleware[] } }> };
  }
)._def.procedures;

async function readKey(mw: Middleware, path: string, input: unknown, isModerator?: boolean) {
  redisFake.packed.get.mockClear();
  redisFake.packed.get.mockResolvedValue(null);
  await mw({
    input,
    ctx: {
      cache: { canCache: false },
      user: isModerator === undefined ? undefined : { id: 1, isModerator },
      features: {},
    },
    next: async () => ({ ok: true, data: { x: 1 } }),
    path,
  });
  const needle = `:${path.replace('.', ':')}:`;
  return redisFake.packed.get.mock.calls.map((call) => call[0] as string).find((k) => k.includes(needle));
}

// By behaviour, not position: these chains also carry a domain middleware and an
// edge-cache one, either of which could move.
async function resolveCacheMiddleware(procedure: string, path: string, probe: unknown) {
  for (const mw of proceduresOf[procedure]._def.middlewares) {
    const key = await readKey(mw, path, probe).catch(() => undefined);
    if (key) return mw;
  }
  throw new Error(`${path} has no middleware reading a cache key`);
}

describe.each([
  ['getLeaderboardPositions', 'leaderboard.getLeaderboardPositions', { userId: 1 }],
  ['getLeaderboard', 'leaderboard.getLeaderboard', { id: 'overall', maxPosition: 1000 }],
])('%s cache key', (procedure, path, input) => {
  let mw: Middleware;
  beforeAll(async () => {
    mw = await resolveCacheMiddleware(procedure, path, input);
  });

  it('moves when the caller is a moderator', async () => {
    const asModerator = await readKey(mw, path, input, true);
    const asAnonymous = await readKey(mw, path, input, undefined);

    expect(asModerator).toBeDefined();
    expect(asModerator).not.toBe(asAnonymous);
  });

  it('does not move between an anonymous and a non-moderator caller', async () => {
    const asUser = await readKey(mw, path, input, false);
    const asAnonymous = await readKey(mw, path, input, undefined);

    expect(asUser).toBe(asAnonymous);
  });
});
