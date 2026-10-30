import { beforeAll, describe, expect, it } from 'vitest';

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { modelRouter } from '~/server/routers/model.router';

/**
 * getModelsPagedSimpleHandler filters each row's meta through
 * `filterModelMetaForClient` / `filterSensitiveProfanityData` by the caller's
 * moderator status, after the service has returned. The input cannot express
 * that, so the key has to.
 */
type Middleware = (opts: {
  input?: unknown;
  ctx: unknown;
  next: () => unknown;
  path: string;
}) => Promise<unknown>;

const PATH = 'model.getAllPagedSimple';
const redisFake = redisMock.redis;

const middlewares = (
  modelRouter as unknown as {
    _def: { procedures: Record<string, { _def: { middlewares: Middleware[] } }> };
  }
)._def.procedures.getAllPagedSimple._def.middlewares;

async function readKey(mw: Middleware, input: unknown, isModerator?: boolean) {
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
    path: PATH,
  });
  return redisFake.packed.get.mock.calls
    .map((call) => call[0] as string)
    .find((k) => k.includes(':model:getAllPagedSimple:'));
}

let mw: Middleware;

beforeAll(async () => {
  for (const candidate of middlewares) {
    const key = await readKey(candidate, { limit: 10 }).catch(() => undefined);
    if (key) {
      mw = candidate;
      return;
    }
  }
  throw new Error(`${PATH} has no middleware reading a cache key`);
});

describe('model.getAllPagedSimple cache key', () => {
  it('moves when the caller is a moderator', async () => {
    const asModerator = await readKey(mw, { limit: 10 }, true);
    const asAnonymous = await readKey(mw, { limit: 10 }, undefined);

    expect(asModerator).toBeDefined();
    expect(asModerator).not.toBe(asAnonymous);
  });

  it('does not move between an anonymous and a non-moderator caller', async () => {
    const asUser = await readKey(mw, { limit: 10 }, false);
    const asAnonymous = await readKey(mw, { limit: 10 }, undefined);

    expect(asUser).toBe(asAnonymous);
  });
});
