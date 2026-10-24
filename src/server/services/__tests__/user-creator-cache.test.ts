import { globSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import type * as Cloudflare from '~/server/cloudflare/client';
import { stripCodeComments } from '~/test-utils/strip-code-comments';
import type * as SessionClient from '~/server/auth/session-client';
import type * as OrchestratorCivitai from '~/server/services/orchestrator/civitai';
import type * as UserLinkService from '~/server/services/user-link.service';
import type * as UserService from '~/server/services/user.service';

const { purgeCache, invalidateHub } = vi.hoisted(() => ({
  purgeCache: vi.fn(),
  invalidateHub: vi.fn(),
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('~/server/cloudflare/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Cloudflare>()),
  purgeCache,
}));
vi.mock('~/server/auth/session-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SessionClient>()),
  sessionClient: { invalidate: invalidateHub },
}));
vi.mock('~/server/services/orchestrator/civitai', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorCivitai>()),
  invalidateCivitaiUser: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/user-link.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserLinkService>()),
  deleteUserLink: vi.fn(async () => undefined),
  upsertManyUserLinks: vi.fn(async () => undefined),
  upsertUserLink: vi.fn(async () => undefined),
}));

// The shop-settings write merges into User.settings with raw SQL; stand in for that one call.
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  patchUserSettings: vi.fn(async () => ({ creatorShop: { enabled: false } })),
  bustUserSettings: vi.fn(async () => undefined),
}));

const { getUserCreator, deleteUserCosmeticCache } = await import('~/server/services/user.service');
const { updateCreatorShopSettings } = await import('~/server/services/creator-shop.service');
const { getUserCreatorHandler } = await import('~/server/controllers/user.controller');
const { clearSessionCache } = await import('~/server/auth/session-cache');
const { bustUserCreator, USER_CREATOR_CACHE_TTL: ttlConstant } = await import(
  '~/server/services/user-creator.service'
);
const { upsertManyUserLinksHandler, upsertUserLinkHandler, deleteUserLinkHandler } = await import(
  '~/server/controllers/user-link.controller'
);
const { refreshEquippedCosmetics } = await import(
  '~/server/services/creator-milestone-grant.service'
);

// Literal, not imported: an expectation derived from the constant moves with a mutated constant.
const TTL_S = 60;
const BUST_WINDOW_S = 2;
const ctx = { user: { id: 4101 } };
const T0 = new Date('2026-10-17T12:00:00.000Z');
const USER = 4101;
const OTHER = 4102;

// A row per user with fields that differ between users, so a result names its user.
const rowFor = (id: number) => ({
  id,
  username: `creator-${id}`,
  image: null,
  muted: false,
  bannedAt: null,
  deletedAt: null,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  publicSettings: {},
  settings: { creatorShop: { enabled: id === USER } },
  excludeFromLeaderboards: true,
  links: [],
  stats: null,
  rank: null,
  cosmetics: [],
  profilePicture: null,
});
let usernames: Record<number, string>;
let modelCounts: Record<number, number>;

const userReads = () => dbMock.dbRead.user.findFirst.mock.calls.length;
const countReads = () => dbMock.dbRead.model.count.mock.calls.length;
const entryKey = (id: number) => `${REDIS_KEYS.CACHES.USER_CREATOR}:${id}`;
let store: ReturnType<typeof installFakeCacheRedis>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  usernames = { [USER]: 'first-name', [OTHER]: 'other-name' };
  modelCounts = { [USER]: 3, [OTHER]: 8 };
  store = installFakeCacheRedis();
  invalidateHub.mockResolvedValue(undefined);
  purgeCache.mockResolvedValue(undefined);
  dbMock.dbRead.user.findFirst.mockImplementation((async ({
    where,
  }: {
    where: { id?: number; username?: string };
  }) => {
    const id =
      where.id ?? Number(Object.entries(usernames).find(([, n]) => n === where.username)?.[0]);
    if (!usernames[id]) return null;
    return { ...rowFor(id), username: usernames[id] };
  }) as never);
  dbMock.dbWrite.user.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => where.id.in.map((id) => ({ username: usernames[id] }))) as never);
  dbMock.dbRead.model.count.mockImplementation(
    (async ({ where }: { where: { userId: number } }) => modelCounts[where.userId]) as never
  );
});
afterEach(() => {
  vi.useRealTimers();
});

describe('creator card cache: hit, miss, TTL', () => {
  it('serves an id lookup from the cache after the first read, both queries included', async () => {
    const first = await getUserCreator({ id: USER });
    const second = await getUserCreator({ id: USER });
    expect(userReads()).toBe(1);
    expect(countReads()).toBe(1);
    for (const c of [first, second]) {
      expect(c?.username).toBe('first-name');
      expect(c?._count.models).toBe(3);
      expect(c?.creatorShopEnabled).toBe(true);
      expect(c).not.toHaveProperty('settings');
    }
    expect((await getUserCreator({ id: OTHER }))?._count.models).toBe(8);
  });

  it('reads the database again once the entry is past its TTL', async () => {
    await getUserCreator({ id: USER });
    vi.setSystemTime(T0.getTime() + (TTL_S - 1) * 1000);
    await getUserCreator({ id: USER });
    expect(userReads()).toBe(1);
    vi.setSystemTime(T0.getTime() + (TTL_S + 1) * 1000);
    await getUserCreator({ id: USER });
    expect(userReads()).toBe(2);
  });

  it('reads a username lookup from the database every time', async () => {
    await getUserCreator({ username: 'first-name' });
    expect((await getUserCreator({ username: 'first-name' }))?.id).toBe(USER);
    expect(userReads()).toBe(2);
  });

  it('does not cache a user it could not find', async () => {
    delete usernames[USER];
    expect(await getUserCreator({ id: USER })).toBeNull();
    usernames[USER] = 'first-name';
    expect((await getUserCreator({ id: USER }))?.username).toBe('first-name');
  });

  it("masking a moderator-only field for one caller does not leak into the next caller's card", async () => {
    const asUser = (isModerator: boolean) =>
      getUserCreatorHandler({
        input: { id: USER },
        ctx: { user: { id: 1, isModerator } },
      } as never);
    expect((await asUser(false))?.excludeFromLeaderboards).toBe(false);
    expect((await asUser(true))?.excludeFromLeaderboards).toBe(true);
    expect(userReads()).toBe(1);
  });

  // INVARIANT GUARD, not regression coverage: with no in-process copy every read decodes a fresh
  // object, so this only goes red if a per-pod L1 or memo sharing objects is added to the read path.
  it('masking on a cache HIT does not leak into a later hit either', async () => {
    const asUser = (isModerator: boolean) =>
      getUserCreatorHandler({
        input: { id: USER },
        ctx: { user: { id: 1, isModerator } },
      } as never);
    await asUser(true); // miss: fills the entry
    expect((await asUser(false))?.excludeFromLeaderboards).toBe(false); // hit, masked
    expect((await asUser(true))?.excludeFromLeaderboards).toBe(true); // hit
    expect(userReads()).toBe(1);
  });

  it('pins the TTL', () => {
    expect(ttlConstant).toBe(60);
  });
});

describe('creator card cache: bust on write', () => {
  /** Warm the entry, change the user in the "database", run the write, read the card. */
  async function afterWrite(write: () => Promise<unknown>) {
    await getUserCreator({ id: USER });
    usernames[USER] = 'renamed';
    await write();
    return (await getUserCreator({ id: USER }))?.username;
  }

  it('control: without a bust the cached card is served', async () => {
    expect(await afterWrite(async () => undefined)).toBe('first-name');
  });

  it('a session refresh or invalidation (clearSessionCache) busts it', async () => {
    expect(await afterWrite(() => clearSessionCache(USER))).toBe('renamed');
  });

  it('equipping or unequipping a cosmetic (deleteUserCosmeticCache) busts it', async () => {
    expect(await afterWrite(() => deleteUserCosmeticCache(USER))).toBe('renamed');
  });

  it('bustUserCreator busts Redis BEFORE purging the edge tag', async () => {
    let entryAtPurge: unknown;
    purgeCache.mockImplementation(async () => {
      entryAtPurge = store.peek(entryKey(USER));
    });
    expect(await afterWrite(() => bustUserCreator(USER))).toBe('renamed');
    expect(purgeCache).toHaveBeenCalledWith({
      tags: [`user-creator-${USER}`, 'user-creator-renamed'],
    });
    expect(entryAtPurge).toMatchObject({ debounce: true });
  });

  it.each([
    ['upsertManyUserLinksHandler', () => upsertManyUserLinksHandler({ input: [], ctx } as never)],
    ['upsertUserLinkHandler', () => upsertUserLinkHandler({ input: {}, ctx } as never)],
    ['deleteUserLinkHandler', () => deleteUserLinkHandler({ input: { id: 9 }, ctx } as never)],
  ])('%s busts it', async (_name, write) => {
    expect(await afterWrite(write)).toBe('renamed');
    expect(purgeCache).toHaveBeenCalledWith({
      tags: [`user-creator-${USER}`, 'user-creator-renamed'],
    });
  });

  it('a milestone cosmetic grant (refreshEquippedCosmetics) busts it', async () => {
    expect(await afterWrite(() => refreshEquippedCosmetics([USER]))).toBe('renamed');
  });

  it('turning the creator shop on or off (updateCreatorShopSettings) busts it', async () => {
    dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
      fn(dbMock.dbWrite)) as never);
    expect(
      await afterWrite(() => updateCreatorShopSettings({ userId: USER, enabled: false } as never))
    ).toBe('renamed');
    expect(purgeCache).toHaveBeenCalledWith({
      tags: [`user-creator-${USER}`, 'user-creator-renamed'],
    });
  });

  it('a bulk grant purges one chunk at a time: the next purge waits for the previous one', async () => {
    // 201 users = two 200-user chunks.
    const ids = Array.from({ length: 201 }, (_, i) => 5000 + i);
    let releaseFirst!: () => void;
    purgeCache.mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseFirst = () => resolve()))
    );
    const grant = refreshEquippedCosmetics(ids);
    await vi.waitFor(() => expect(purgeCache).toHaveBeenCalledTimes(1));
    // Give a non-waiting loop every chance to start the second chunk.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(purgeCache).toHaveBeenCalledTimes(1);
    releaseFirst();
    await grant;
    expect(purgeCache).toHaveBeenCalledTimes(2);
    expect((purgeCache.mock.calls[1][0] as { tags: string[] }).tags).toEqual(['user-creator-5200']);
  });

  it('reads inside the bust window go to the database uncached; the first read after it is cached', async () => {
    await getUserCreator({ id: USER });
    await bustUserCreator(USER);

    // Inside the window (halfway), every read goes to the database and nothing is written back, so
    // a read landing inside replication lag cannot re-cache the pre-write card.
    vi.setSystemTime(T0.getTime() + (BUST_WINDOW_S * 1000) / 2);
    await getUserCreator({ id: USER });
    await getUserCreator({ id: USER });
    expect(userReads()).toBe(3);
    expect(store.peek(entryKey(USER))).toMatchObject({ debounce: true });

    // Past the window the marker is gone: the next read refills and the one after it is a hit.
    vi.setSystemTime(T0.getTime() + (BUST_WINDOW_S + 1) * 1000);
    await getUserCreator({ id: USER });
    await getUserCreator({ id: USER });
    expect(userReads()).toBe(4);
    expect(store.peek(entryKey(USER))).toMatchObject({ id: USER, username: 'first-name' });
  });

  it('a Redis failure during the bust does not fail the write', async () => {
    redisMock.redis.packed.set.mockRejectedValue(new Error('cache cluster down') as never);
    await expect(clearSessionCache(USER)).resolves.toBeUndefined();
    await expect(bustUserCreator(USER)).resolves.toBeUndefined();
  });
});

/**
 * Every write that drops the creator card's edge copy must drop the Redis copy first, or the edge
 * refills from the stale entry. So the edge tag is spelled in one place, and the callers of the
 * helper that purges both are listed here. The set growing or shrinking fails: a new purge site is
 * a new writer to check, and a removed one is a write that no longer invalidates the card.
 */
describe('creator card invalidation ledger', () => {
  const ROOT = path.resolve(__dirname, '../../../..');
  const sources = globSync('src/**/*.{ts,tsx}', { cwd: ROOT })
    .map((f) => f.split(path.sep).join('/'))
    .filter(
      (f) => !/(__tests__|\.test\.|\.spec\.)/.test(f) && statSync(path.join(ROOT, f)).isFile()
    );
  const read = (f: string) => readFileSync(path.join(ROOT, f), 'utf8');
  /** Calls of `name(` in code, not in comments: a commented-out call is not a bust. */
  const callsIn = (text: string, name: string) =>
    (stripCodeComments(text).match(new RegExp(`\\b${name}\\(`, 'g')) ?? []).length;

  it('does not count a commented-out call (instrument control)', () => {
    const text = [
      '// await bustUserCreator(id);',
      '/* await bustUserCreator(id); */',
      '  /**',
      '   * bustUserCreator(id) in a doc comment',
      '   */',
      'await bustUserCreator(id);',
    ].join('\n');
    expect(callsIn(text, 'bustUserCreator')).toBe(1);
  });

  it('finds the source tree (instrument control)', () => {
    expect(sources.length).toBeGreaterThan(1000);
  });

  it('spells the user-creator edge tag only in the cache module', () => {
    const spelled = sources.filter((f) => read(f).includes('user-creator-')).sort();
    expect(spelled).toEqual(['src/server/services/user-creator.service.ts']);
  });

  it('the router tags its responses with the same helper the busts purge', () => {
    expect(read('src/server/routers/user.router.ts')).toMatch(
      /userCreatorEdgeTag\(input\.id\)[\s\S]*userCreatorEdgeTag\(input\.username\)/
    );
  });

  it('lists every caller of bustUserCreator', () => {
    const calls: Record<string, number> = {};
    for (const f of sources) {
      if (f === 'src/server/services/user-creator.service.ts') continue;
      const n = callsIn(read(f), 'bustUserCreator');
      if (n) calls[f] = n;
    }
    expect(calls).toEqual({
      'src/server/controllers/user-link.controller.ts': 3,
      'src/server/controllers/user-profile.controller.ts': 2,
      'src/server/controllers/user.controller.ts': 1,
      'src/server/services/creator-milestone-grant.service.ts': 1,
      'src/server/services/creator-shop.service.ts': 1,
    });
  });

  it('lists every caller of bustUserCreatorCache (Redis only)', () => {
    const calls: Record<string, number> = {};
    for (const f of sources) {
      if (f === 'src/server/services/user-creator.service.ts') continue;
      const n = callsIn(read(f), 'bustUserCreatorCache');
      if (n) calls[f] = n;
    }
    expect(calls).toEqual({
      'src/server/auth/session-cache.ts': 1,
      'src/server/services/cosmetic.service.ts': 1,
      'src/server/services/user.service.ts': 1,
    });
  });
});
