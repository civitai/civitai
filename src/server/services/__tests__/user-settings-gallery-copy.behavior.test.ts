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
 * `copyGallerySettingsToAllModelsByUser` writes `User.settings` from inside an interactive
 * transaction. It used to replace the WHOLE column from a JS snapshot, and it never busted
 * the settings cache.
 *
 * It lives in its own file because `model.service` needs a much larger set of import-time
 * stubs than the other settings writers, and pulling those into the shared behaviour file
 * would change the mock environment every test in it runs under.
 *
 * Two mutants survived the battery before this file existed — `mergeInto` -> `set` (the
 * whole-sub-object replace this change exists to remove) and deleting the cache bust — so
 * this is regression coverage for both, not decoration.
 */

const holder = {
  db: null as unknown as PGlite,
  gate: null as unknown as Gate,
  bridge: null as unknown as ReturnType<typeof createPrismaBridge>,
};

const { settingsCacheBust, metricPrivacyBust, countCacheRefresh } = vi.hoisted(() => ({
  settingsCacheBust: vi.fn(async () => undefined),
  metricPrivacyBust: vi.fn(async () => undefined),
  countCacheRefresh: vi.fn(async () => undefined),
}));

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

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  userModelCountCache: { refresh: countCacheRefresh },
}));

const { copyGallerySettingsToAllModelsByUser } = await import('~/server/services/model.service');

const USER_ID = 4242;

function installBridge() {
  const b = holder.bridge;
  for (const root of [dbMock.dbWrite, dbMock.dbRead]) {
    root.$queryRaw.mockImplementation(b.$queryRaw);
    root.$queryRawUnsafe.mockImplementation(b.$queryRawUnsafe);
    root.$executeRaw.mockImplementation(b.$executeRaw);
    root.$executeRawUnsafe.mockImplementation(b.$executeRawUnsafe);
    root.$transaction.mockImplementation(b.$transaction);
    root.user.findUnique.mockImplementation(b.user.findUnique);
  }
  // No models come back, so the per-model cache-key loop is a no-op here; the assertions
  // are about the USER settings column.
  dbMock.dbWrite.model.findMany.mockResolvedValue([]);
}

describe('copyGallerySettingsToAllModelsByUser — merges the settings column, does not replace it', () => {
  beforeAll(async () => {
    holder.db = new PGlite();
    await createUserSchema(holder.db);
    await holder.db.exec(`
      CREATE TABLE IF NOT EXISTS "Model" (
        id               int PRIMARY KEY,
        "userId"         int NOT NULL,
        minor            boolean NOT NULL DEFAULT false,
        "sfwOnly"        boolean NOT NULL DEFAULT false,
        "gallerySettings" jsonb NOT NULL DEFAULT '{}'::jsonb
      );
    `);
  }, 60_000);

  afterAll(async () => {
    await holder.db?.close();
  });

  beforeEach(async () => {
    holder.gate = createGate();
    holder.bridge = createPrismaBridge(holder.db, holder.gate);
    installBridge();
    settingsCacheBust.mockClear();
    metricPrivacyBust.mockClear();
    await holder.db.exec(`TRUNCATE "Model";`);
  });

  it('keeps unrelated settings keys and merges into gallerySettings', async () => {
    await seedUser(holder.db, USER_ID, {
      dismissedAlerts: ['keep-me'],
      allowAds: true,
      // A sub-key the copy does not send. The whole-sub-object replace drops it.
      gallerySettings: { level: 1, users: [7] },
    });

    await copyGallerySettingsToAllModelsByUser({
      userId: USER_ID,
      settings: { level: 31, tags: [99] },
    });

    const settings = await readSettings(holder.db, USER_ID);
    // The whole-COLUMN replace lost these.
    expect(settings.dismissedAlerts).toEqual(['keep-me']);
    expect(settings.allowAds).toBe(true);

    const gallery = settings.gallerySettings as Record<string, unknown>;
    // The keys this call sent win …
    expect(gallery.level).toBe(31);
    expect(gallery.tags).toEqual([99]);
    // … and the sibling sub-key it did not send survives. This is what `mergeInto` buys
    // over `set`, and the only assertion here that separates them.
    expect(gallery.users).toEqual([7]);
  });

  it('busts the user-settings cache after the transaction commits', async () => {
    await seedUser(holder.db, USER_ID, { gallerySettings: { level: 1 } });

    await copyGallerySettingsToAllModelsByUser({
      userId: USER_ID,
      settings: { level: 31, users: [], tags: [] },
    });

    // This writer never busted at all before the change; without the assertion, deleting
    // the bust leaves the whole suite green.
    expect(settingsCacheBust).toHaveBeenCalledWith([USER_ID]);
    expect(countCacheRefresh).toHaveBeenCalledWith(USER_ID);
  });

  it('still forces the SFW level on a flagged model', async () => {
    // INVARIANT GUARD: unchanged by this PR, but the model statement sits in the same
    // transaction as the settings write and must not be disturbed by it.
    await seedUser(holder.db, USER_ID, {});
    await holder.db.query(
      `INSERT INTO "Model" (id, "userId", minor, "sfwOnly", "gallerySettings")
       VALUES (1, $1, false, false, '{}'::jsonb), (2, $1, true, false, '{}'::jsonb)`,
      [USER_ID]
    );

    await copyGallerySettingsToAllModelsByUser({
      userId: USER_ID,
      settings: { level: 31, users: [], tags: [] },
    });

    const rows = await holder.db.query<{ id: number; gallerySettings: { level: unknown } }>(
      `SELECT id, "gallerySettings" FROM "Model" ORDER BY id`
    );
    // Compared as strings: the bridge binds this statement's values untyped, so Postgres
    // infers `text` and the jsonb holds "31" rather than 31. Prisma sends a typed
    // parameter, so the stored TYPE here is a harness artifact and is not what this guard
    // is about — the guard is that the two models get DIFFERENT levels.
    const level = (i: number) => String(rows.rows[i].gallerySettings.level);
    expect(level(0)).toBe('31');
    expect(level(1)).not.toBe('31');
    expect(level(0)).not.toBe(level(1));
  });
});
