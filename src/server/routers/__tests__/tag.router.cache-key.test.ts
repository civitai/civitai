import { beforeAll, describe, expect, it } from 'vitest';

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { tagRouter } from '~/server/routers/tag.router';

/**
 * The cache-key decision lives at the `cacheIt` call site, so this drives the
 * real procedure's middleware chain. The sibling suite over `cacheIt` itself
 * passes its own options in, and so cannot see this router's configuration
 * change.
 *
 * No `vi.mock` here on purpose: mocking `~/server/trpc` — as that sibling does
 * to unwrap `middleware()` — would take `router()` and `publicProcedure` with
 * it, and there would be no router left to import.
 */
type Middleware = (opts: {
  input?: unknown;
  ctx: unknown;
  next: () => unknown;
  path: string;
}) => Promise<unknown>;

const redisFake = redisMock.redis;

const middlewares = (
  tagRouter as unknown as {
    _def: { procedures: { getAll: { _def: { middlewares: Middleware[] } } } };
  }
)._def.procedures.getAll._def.middlewares;

async function readKey(mw: Middleware, input: unknown, adminTags?: boolean) {
  redisFake.packed.get.mockClear();
  redisFake.packed.get.mockResolvedValue(null);
  await mw({
    input,
    // canCache false so the miss path stops at the read.
    ctx: { cache: { canCache: false }, user: undefined, features: { adminTags } },
    next: async () => ({ ok: true, data: { x: 1 } }),
    path: 'tag.getAll',
  });
  return redisFake.packed.get.mock.calls
    .map((call) => call[0] as string)
    .find((key) => key.includes(':tag:getAll:'));
}

// Found by what it does, not by its position in the chain — a middleware added
// or reordered above it must not silently retarget this suite.
let cacheMiddleware: Middleware;

beforeAll(async () => {
  for (const mw of middlewares) {
    const key = await readKey(mw, {}).catch(() => undefined);
    if (key) {
      cacheMiddleware = mw;
      return;
    }
  }
  throw new Error('tag.getAll has no middleware reading a tag:getAll cache key');
});

const keyFor = (input: unknown, adminTags?: boolean) => readKey(cacheMiddleware, input, adminTags);

describe('tag.getAll cache key', () => {
  it.each(['excludedImageIds', 'excludedUserIds', 'excludedModelIds'] as const)(
    'does NOT move when %s changes — getTags never reads it',
    async (field) => {
      const base = await keyFor({ excludedTagIds: [7] });
      const withField = await keyFor({ excludedTagIds: [7], [field]: [1, 2, 3] });

      expect(withField).toBe(base);
    }
  );

  it('moves when excludedTagIds changes', async () => {
    const a = await keyFor({ excludedTagIds: [7] });
    const b = await keyFor({ excludedTagIds: [7, 8] });

    expect(b).not.toBe(a);
  });

  it('moves when the adminTags dimension changes', async () => {
    const asAdmin = await keyFor({ excludedTagIds: [7] }, true);
    const asAnon = await keyFor({ excludedTagIds: [7] }, undefined);

    expect(asAdmin).not.toBe(asAnon);
  });
});
