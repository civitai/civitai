import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * `blocks.persistGenerationSource`'s bounds, driven through the REAL limiters on an in-memory
 * store: the per-user bucket (`checkBlockGenerationSourceUserRateLimit`) and the per-user
 * in-flight cap (`withInFlightLimit`). The per-user `rateLimit` middleware is a pass-through here,
 * which is exactly what it is for a moderator (the current flag audience) and in dev, test and
 * preview — so every bound these cases see is one that holds for those callers too.
 *
 * The service is a mock: it is the thing being bounded, not under test.
 */

const {
  mockAuthorizeBlockBridgeToken,
  mockParseSubjectUserId,
  mockIsAppBlocksEnabled,
  mockGetSessionUser,
  mockPersistSource,
} = vi.hoisted(() => ({
  mockAuthorizeBlockBridgeToken: vi.fn(),
  mockParseSubjectUserId: vi.fn(),
  mockIsAppBlocksEnabled: vi.fn(),
  mockGetSessionUser: vi.fn(),
  mockPersistSource: vi.fn(),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', () => ({
  authorizeBlockBridgeToken: (...a: unknown[]) => mockAuthorizeBlockBridgeToken(...a),
}));
vi.mock('~/server/middleware/block-scope.middleware', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, parseSubjectUserId: (...a: unknown[]) => mockParseSubjectUserId(...a) };
});
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksEnabled: (...a: unknown[]) => mockIsAppBlocksEnabled(...a),
  isAppBlocksAuthorEnabled: vi.fn(),
  isAppBlocksPostCreationEnabled: vi.fn(),
}));
vi.mock('~/server/auth/session-client', () => ({
  sessionClient: { getSessionUserById: (...a: unknown[]) => mockGetSessionUser(...a) },
}));
vi.mock('~/server/services/blocks/block-generation-source.service', () => ({
  persistBlockGenerationSource: (...a: unknown[]) => mockPersistSource(...a),
}));
// `rateLimit` cannot be evaluated here (top-level `Prisma.validator`); a pass-through is also
// what it is for a moderator.
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const MODERATOR_ID = 42;
const OTHER_MODERATOR_ID = 43;

const RESULT = {
  url: 'https://image.civitai.com/x/k/original=true/k.jpeg',
  width: 512,
  height: 512,
  imageId: 1,
  ready: true,
};

function claims(userId: number) {
  return {
    sub: `user:${userId}`,
    scopes: ['ai:write:budgeted'],
    appId: 'appblk-alpha',
    appBlockId: 'apb_alpha',
    blockInstanceId: 'page_apb_alpha',
    blockId: 'my-app',
    maxBrowsingLevel: 1,
    ctx: { slotId: 'page', entityType: 'none' },
  };
}

function call(userId = MODERATOR_ID, imageIndex = 0) {
  return blocksRouter
    .createCaller({
      acceptableOrigin: true,
      user: { id: userId, isModerator: true },
      apiKeyId: null,
      tokenScope: TokenScope.Full,
      ip: '203.0.113.9',
      req: { headers: {} } as never,
      res: { setHeader: () => undefined } as never,
      cache: { edgeTTL: 0 },
      features: {} as never,
      track: { post: vi.fn(async () => undefined) },
    } as never)
    .persistGenerationSource({ blockToken: `tok-${userId}`, workflowId: 'wf_1', imageIndex });
}

/** An in-memory stand-in for the counter and sorted-set commands the two limiters use. */
function installStore() {
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  const sets = new Map<string, Map<string, number>>();
  const set = (k: string) => {
    let s = sets.get(k);
    if (!s) sets.set(k, (s = new Map()));
    return s;
  };
  const r = redisMock.redis;
  r.incrBy.mockImplementation((async (k: string, by: number) => {
    const n = (counters.get(k) ?? 0) + by;
    counters.set(k, n);
    return n;
  }) as never);
  r.expire.mockImplementation((async (k: string, s: number) => {
    ttls.set(k, s);
    return true;
  }) as never);
  r.ttl.mockImplementation((async (k: string) => ttls.get(k) ?? -1) as never);
  r.zRemRangeByScore.mockImplementation((async (k: string, _min: string, max: number) => {
    for (const [m, score] of set(k)) if (score <= max) set(k).delete(m);
    return 0;
  }) as never);
  r.zAdd.mockImplementation((async (k: string, e: { score: number; value: string }) => {
    set(k).set(e.value, e.score);
    return 1;
  }) as never);
  r.zCard.mockImplementation((async (k: string) => set(k).size) as never);
  r.zRem.mockImplementation((async (k: string, m: string) => (set(k).delete(m) ? 1 : 0)) as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  installStore();
  mockAuthorizeBlockBridgeToken.mockImplementation(async (token: string) =>
    claims(Number(token.slice('tok-'.length)))
  );
  mockParseSubjectUserId.mockImplementation((sub: string) => Number(sub.slice('user:'.length)));
  mockIsAppBlocksEnabled.mockResolvedValue(true);
  mockGetSessionUser.mockImplementation(async (id: number) => ({ id, isModerator: true }));
  mockPersistSource.mockResolvedValue(RESULT);
});

describe('blocks.persistGenerationSource — bounds that hold for moderators', () => {
  it('🔴 a moderator’s 61st call in the hour is refused, and never reaches the service', async () => {
    for (let i = 0; i < 60; i++) await expect(call(MODERATOR_ID, i % 5)).resolves.toEqual(RESULT);
    await expect(call()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many generation sources saved — slow down.',
    });
    expect(mockPersistSource).toHaveBeenCalledTimes(60);
  });

  it('the hourly bucket is per user: another moderator is not refused', async () => {
    for (let i = 0; i < 61; i++) await call().catch(() => undefined);
    await expect(call(OTHER_MODERATOR_ID)).resolves.toEqual(RESULT);
  });

  it('🔴 a third concurrent call is refused while two are in flight, and admitted once one ends', async () => {
    const finish: Array<() => void> = [];
    mockPersistSource.mockImplementation(
      () => new Promise((resolve) => finish.push(() => resolve(RESULT)))
    );
    // One at a time, so each acquire sees the slots the earlier ones hold.
    const first = call();
    await vi.waitFor(() => expect(mockPersistSource).toHaveBeenCalledTimes(1));
    const second = call();
    await vi.waitFor(() => expect(mockPersistSource).toHaveBeenCalledTimes(2));

    await expect(call()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      message: 'A generation source is already being saved — wait for it to finish.',
    });
    expect(mockPersistSource).toHaveBeenCalledTimes(2);
    // Another user's calls hold their own slots.
    const other = call(OTHER_MODERATOR_ID);
    await vi.waitFor(() => expect(mockPersistSource).toHaveBeenCalledTimes(3));

    finish.shift()!();
    await expect(first).resolves.toEqual(RESULT);
    // The slot is released without being awaited; one macrotask lets it land.
    await new Promise((r) => setTimeout(r, 0));
    const fourth = call();
    await vi.waitFor(() => expect(mockPersistSource).toHaveBeenCalledTimes(4));
    finish.splice(0).forEach((f) => f());
    await expect(fourth).resolves.toEqual(RESULT);
    await expect(second).resolves.toEqual(RESULT);
    await expect(other).resolves.toEqual(RESULT);
  });

  it('an in-flight refusal spends nothing from the hourly bucket', async () => {
    const finish: Array<() => void> = [];
    mockPersistSource.mockImplementation(
      () => new Promise((resolve) => finish.push(() => resolve(RESULT)))
    );
    const a = call();
    await vi.waitFor(() => expect(mockPersistSource).toHaveBeenCalledTimes(1));
    const b = call();
    await vi.waitFor(() => expect(mockPersistSource).toHaveBeenCalledTimes(2));
    for (let i = 0; i < 5; i++) await call().catch(() => undefined);
    finish.splice(0).forEach((f) => f());
    await Promise.all([a, b]);
    const key = [...redisMock.redis.incrBy.mock.calls.map((c) => c[0] as string)].find((k) =>
      k.includes('gen-source-user')
    );
    expect(key).toBeDefined();
    expect(redisMock.redis.incrBy.mock.calls.filter((c) => c[0] === key)).toHaveLength(2);
  });
});

// 🔴 The persist ceiling is the VIEWER's level (#8786), the same as every other site:
// the domain ceiling intersected with `viewerBrowsingLevel`, PG without one, and this
// signed-in viewer's level floored at PG|PG-13 first. Levels are pairwise distinct
// (domain 31, viewers 1 and 5, results 3, 7 and 1), so a site that passed the domain
// ceiling (31), the raw viewer level, or the level without its floor (1, 5) fails.
describe('blocks.persistGenerationSource — the output ceiling is the viewer level', () => {
  it.each([
    [{ maxBrowsingLevel: 31, viewerBrowsingLevel: 1 }, 3],
    [{ maxBrowsingLevel: 31, viewerBrowsingLevel: 5 }, 7],
    [{ maxBrowsingLevel: 31 }, 1],
  ] as const)('claims %o pass ceiling %i', async (over, level) => {
    mockAuthorizeBlockBridgeToken.mockImplementationOnce(async () => ({
      ...claims(MODERATOR_ID),
      ...over,
    }));
    await expect(call()).resolves.toEqual(RESULT);
    expect(mockPersistSource).toHaveBeenCalledWith(
      expect.objectContaining({ ceiling: { maxBrowsingLevel: level, serving: false } })
    );
  });
});
