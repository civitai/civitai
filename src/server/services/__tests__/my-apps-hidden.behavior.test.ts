import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  createGate,
  createPrismaBridge,
  createUserSchema,
  readSettings,
  seedUser,
  type Gate,
} from './user-settings-race.harness';

/**
 * "Remove from My apps" against a real Postgres (PGlite): the statements
 * `my-apps-hidden.service.ts` emits through `patchUserSettings` (`mergeInto` for a hide,
 * the new `removeFrom` for an unhide and the cap) run for real, so the assertions are about
 * what the stored `User.settings` becomes — above all that ONLY `hiddenApps` moves and every
 * other settings key survives.
 */

const holder = {
  db: null as unknown as PGlite,
  gate: null as unknown as Gate,
  bridge: null as unknown as ReturnType<typeof createPrismaBridge>,
};

const { settingsCacheBust, metricPrivacyBust } = vi.hoisted(() => ({
  settingsCacheBust: vi.fn(async () => undefined),
  metricPrivacyBust: vi.fn(async () => undefined),
}));

// The cache's `fetch` calls straight through to its `lookupFn`, so `getMyHiddenApps` reads
// the seeded row through the real row -> cached-object mapping.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: vi.fn((opts: { lookupFn: (ids: number[]) => Promise<unknown> }) => ({
    fetch: async (ids: number | number[]) =>
      opts.lookupFn(Array.isArray(ids) ? ids : [ids]) as Promise<Record<string, unknown>>,
    bust: settingsCacheBust,
    refresh: async () => undefined,
    flush: async () => undefined,
  })),
}));

vi.mock('~/server/services/creator-membership.service', () => ({
  bustUserMetricPrivacyDefaultsCache: metricPrivacyBust,
}));

const { hideMyApp, unhideMyApp, getMyHiddenApps } = await import(
  '~/server/services/blocks/my-apps-hidden.service'
);
const { HIDDEN_APPS_MAX } = await import('~/shared/utils/my-apps-hidden');

const USER_ID = 7381;
const OTHER_USER_ID = 7382;
const T1 = new Date('2026-10-10T11:22:33.000Z');
const T2 = new Date('2026-10-12T19:20:21.000Z');
const T3 = new Date('2026-10-14T07:08:09.000Z');

/** Settings keys unrelated to My apps, seeded on every row to prove a write leaves them be. */
const UNRELATED = {
  preferredFiatCurrency: 'EUR',
  dismissedAlerts: ['keep-me'],
  gallerySettings: { level: 3, users: [11] },
};

function installBridge() {
  const b = holder.bridge;
  for (const root of [dbMock.dbWrite, dbMock.dbRead]) {
    root.$queryRaw.mockImplementation(b.$queryRaw);
    root.$queryRawUnsafe.mockImplementation(b.$queryRawUnsafe);
    root.$executeRaw.mockImplementation(b.$executeRaw);
    root.$executeRawUnsafe.mockImplementation(b.$executeRawUnsafe);
    root.$transaction.mockImplementation(b.$transaction);
    root.user.findUnique.mockImplementation(b.user.findUnique);
    root.user.update.mockImplementation(b.user.update);
  }
}

describe('my-apps hidden — stored User.settings', () => {
  beforeAll(async () => {
    holder.db = new PGlite();
    await createUserSchema(holder.db);
  }, 60_000);

  afterAll(async () => {
    await holder.db?.close();
  });

  beforeEach(async () => {
    holder.gate = createGate();
    holder.bridge = createPrismaBridge(holder.db, holder.gate);
    installBridge();
    settingsCacheBust.mockClear();
    await seedUser(holder.db, USER_ID, UNRELATED);
    await seedUser(holder.db, OTHER_USER_ID, { ...UNRELATED, preferredFiatCurrency: 'GBP' });
  });

  it('🔴 a hide writes ONLY hiddenApps[slug]; every other settings key survives', async () => {
    const result = await hideMyApp({ userId: USER_ID, slug: 'pixel-forge', now: T1 });
    expect(result).toEqual({ slug: 'pixel-forge', hiddenAt: T1.toISOString() });
    expect(await readSettings(holder.db, USER_ID)).toEqual({
      ...UNRELATED,
      hiddenApps: { 'pixel-forge': T1.toISOString() },
    });
    // …and only for the caller.
    expect(await readSettings(holder.db, OTHER_USER_ID)).toEqual({
      ...UNRELATED,
      preferredFiatCurrency: 'GBP',
    });
    // The settings cache is busted, so the next listMyApps read sees the hide.
    expect(settingsCacheBust).toHaveBeenCalled();
  });

  it('a second hide of ANOTHER slug merges beside the first (no clobber within the map)', async () => {
    await hideMyApp({ userId: USER_ID, slug: 'pixel-forge', now: T1 });
    await hideMyApp({ userId: USER_ID, slug: 'tag-wizard', now: T2 });
    expect((await readSettings(holder.db, USER_ID)).hiddenApps).toEqual({
      'pixel-forge': T1.toISOString(),
      'tag-wizard': T2.toISOString(),
    });
  });

  it('🔴 hide is idempotent: repeating it keeps ONE entry, at the latest hide time', async () => {
    await hideMyApp({ userId: USER_ID, slug: 'pixel-forge', now: T1 });
    await hideMyApp({ userId: USER_ID, slug: 'pixel-forge', now: T3 });
    expect((await readSettings(holder.db, USER_ID)).hiddenApps).toEqual({
      'pixel-forge': T3.toISOString(),
    });
  });

  it('🔴 unhide removes ONLY that slug; siblings and unrelated keys survive', async () => {
    await hideMyApp({ userId: USER_ID, slug: 'pixel-forge', now: T1 });
    await hideMyApp({ userId: USER_ID, slug: 'tag-wizard', now: T2 });
    await unhideMyApp({ userId: USER_ID, slug: 'pixel-forge' });
    expect(await readSettings(holder.db, USER_ID)).toEqual({
      ...UNRELATED,
      hiddenApps: { 'tag-wizard': T2.toISOString() },
    });
  });

  it('unhide is idempotent: unhiding an app that is not hidden is a no-op success', async () => {
    await unhideMyApp({ userId: USER_ID, slug: 'never-hidden' });
    await unhideMyApp({ userId: USER_ID, slug: 'never-hidden' });
    const stored = await readSettings(holder.db, USER_ID);
    expect(stored).toEqual({ ...UNRELATED, hiddenApps: {} });
  });

  it('a malformed stored hiddenApps (a scalar) is repaired by the next write, not concatenated', async () => {
    await seedUser(holder.db, USER_ID, { ...UNRELATED, hiddenApps: 7 });
    await hideMyApp({ userId: USER_ID, slug: 'pixel-forge', now: T1 });
    expect((await readSettings(holder.db, USER_ID)).hiddenApps).toEqual({
      'pixel-forge': T1.toISOString(),
    });
    await seedUser(holder.db, USER_ID, { ...UNRELATED, hiddenApps: [1, 2] });
    await unhideMyApp({ userId: USER_ID, slug: 'pixel-forge' });
    expect((await readSettings(holder.db, USER_ID)).hiddenApps).toEqual({});
  });

  it('🔴 the cap: a hide past HIDDEN_APPS_MAX drops the OLDEST, keeps the new one', async () => {
    const full = Object.fromEntries(
      Array.from({ length: HIDDEN_APPS_MAX }, (_, i) => [
        `app-${i}`,
        new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      ])
    );
    await seedUser(holder.db, USER_ID, { ...UNRELATED, hiddenApps: full });
    await hideMyApp({ userId: USER_ID, slug: 'newest', now: T1 });
    const stored = await readSettings(holder.db, USER_ID);
    const hidden = stored.hiddenApps as Record<string, string>;
    expect(Object.keys(hidden)).toHaveLength(HIDDEN_APPS_MAX);
    expect(hidden).not.toHaveProperty('app-0'); // the oldest
    expect(hidden).toHaveProperty('app-1');
    expect(hidden.newest).toBe(T1.toISOString());
    expect(stored.preferredFiatCurrency).toBe('EUR');
  });

  it('getMyHiddenApps returns the sanitised map (garbage entries dropped)', async () => {
    await seedUser(holder.db, USER_ID, {
      ...UNRELATED,
      hiddenApps: { 'pixel-forge': T1.toISOString(), junk: 'soon' },
    });
    expect(await getMyHiddenApps(USER_ID)).toEqual({ 'pixel-forge': T1.toISOString() });
  });
});
