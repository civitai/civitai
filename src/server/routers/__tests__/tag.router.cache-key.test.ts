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

type User = { id: number; isModerator?: boolean } | undefined;

async function readKey(mw: Middleware, input: unknown, adminTags?: boolean, user?: User) {
  redisFake.packed.get.mockClear();
  redisFake.packed.get.mockResolvedValue(null);
  await mw({
    input,
    // canCache false so the miss path stops at the read.
    ctx: { cache: { canCache: false }, user, features: { adminTags } },
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

const keyFor = (input: unknown, adminTags?: boolean, user?: User) =>
  readKey(cacheMiddleware, input, adminTags, user);

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

  // With a modelId the handler answers per viewer (a draft model's tags are its owner's), so a
  // key shared across viewers would serve one viewer's answer to another.
  it('moves between viewers when a modelId is given', async () => {
    const input = { modelId: 5 };
    const keys = [
      await keyFor(input),
      await keyFor(input, undefined, { id: 1 }),
      await keyFor(input, undefined, { id: 2 }),
      await keyFor(input, undefined, { id: 2, isModerator: true }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('stays shared across viewers without a modelId (control)', async () => {
    const anon = await keyFor({ excludedTagIds: [7] });
    const signedIn = await keyFor({ excludedTagIds: [7] }, undefined, { id: 1 });
    expect(signedIn).toBe(anon);
  });
});
