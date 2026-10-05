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
 * The settings writers and the settings cache against a stored `User.settings` that is
 * not a JSON object AT THE TOP LEVEL.
 *
 * `user-settings-mergeinto-malformed.behavior.test.ts` pins the nested-key guards; this
 * file pins the column itself. Nothing in Postgres enforces that `settings` is an object,
 * and `COALESCE(settings, '{}')` replaces only SQL NULL — a stored JSON `null` or an array
 * passes through it. On such a value:
 *  - `jsonb || jsonb` CONCATENATES rather than merging, so every write appends another
 *    element to an ever-growing array and no key is ever readable again;
 *  - `jsonb_set` RAISES, so a notice dismissal fails outright;
 *  - spreading the value in JS yields `"0"`, `"1"`, … keys.
 *
 * Every write must instead leave an OBJECT holding the written keys (self-healing), and the
 * cache must never surface numeric keys.
 *
 * SCOPE. The statements the service actually emits run against a real Postgres (PGlite),
 * so the assertions are about what `jsonb ||` and `jsonb_set` really do, not about the
 * statement text.
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

// The cache's `fetch` calls straight through to its `lookupFn`, so the cache tests below
// exercise the real row -> cached-object mapping against the seeded row.
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

const {
  getUserContentSettings,
  getUserSettings,
  patchUserSettings,
  setAlertDismissed,
  setUserSetting,
} = await import('~/server/services/user.service');

const USER_ID = 6160;

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

/**
 * Each is a stored top-level value that is not an object. JSON `null` and the
 * already-concatenated array are the two shapes a real row can be found in; the scalars
 * are the rest of the set `jsonb ||` concatenates and `jsonb_set` rejects.
 */
const MALFORMED: [string, unknown][] = [
  ['JSON null', null],
  ['an already-concatenated array', [null, { allowAds: false }]],
  ['an empty array', []],
  ['a number', 7],
  ['a string', 'nope'],
];

const isPlainObject = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);

describe('a non-object stored User.settings', () => {
  beforeAll(async () => {
    holder.db = new PGlite();
    await createUserSchema(holder.db);
  }, 60_000);

  afterAll(async () => {
    await holder.db?.close();
  });

  beforeEach(() => {
    holder.gate = createGate();
    holder.bridge = createPrismaBridge(holder.db, holder.gate);
    installBridge();
    settingsCacheBust.mockClear();
    metricPrivacyBust.mockClear();
  });

  describe('setUserSetting', () => {
    it.each(MALFORMED)(
      'replaces %s with an object holding the written keys, rather than appending to it',
      async (_label, bad) => {
        await seedUser(holder.db, USER_ID, bad);

        const returned = await setUserSetting(USER_ID, {
          preferredFiatCurrency: 'EUR',
          hideBlueBuzzInHeader: true,
        });
        const stored = await readSettings(holder.db, USER_ID);

        for (const settings of [returned as unknown, stored as unknown]) {
          // Assert the STATE — exactly the written keys, as an object — not merely "not an
          // array": a scalar survivor would walk a negative assertion.
          expect(isPlainObject(settings)).toBe(true);
          expect(settings).toEqual({ preferredFiatCurrency: 'EUR', hideBlueBuzzInHeader: true });
        }
      }
    );

    it('leaves the row healed, so the next write merges normally instead of appending', async () => {
      await seedUser(holder.db, USER_ID, null);

      await setUserSetting(USER_ID, { preferredFiatCurrency: 'EUR' });
      await setUserSetting(USER_ID, { hideBlueBuzzInHeader: true });

      expect(await readSettings(holder.db, USER_ID)).toEqual({
        preferredFiatCurrency: 'EUR',
        hideBlueBuzzInHeader: true,
      });
    });

    /**
     * CONTROL — the guard must not fire on a well-formed object. An implementation that
     * always started from `{}` would pass every malformed case above while wiping every
     * other setting on each write.
     */
    it('merges onto a well-formed object without discarding its other keys', async () => {
      await seedUser(holder.db, USER_ID, { dismissedAlerts: ['keep-me'], allowAds: false });

      await setUserSetting(USER_ID, { preferredFiatCurrency: 'EUR' });

      expect(await readSettings(holder.db, USER_ID)).toEqual({
        dismissedAlerts: ['keep-me'],
        allowAds: false,
        preferredFiatCurrency: 'EUR',
      });
    });

    /** CONTROL — SQL NULL, the one case the old `COALESCE` did cover, must still work. */
    it('initialises a SQL NULL column', async () => {
      await seedUser(holder.db, USER_ID, {});
      await holder.db.query(`UPDATE "User" SET settings = NULL WHERE id = $1`, [USER_ID]);

      await setUserSetting(USER_ID, { preferredFiatCurrency: 'EUR' });

      expect(await readSettings(holder.db, USER_ID)).toEqual({ preferredFiatCurrency: 'EUR' });
    });
  });

  describe('patchUserSettings with nothing to write', () => {
    it.each(MALFORMED)('returns {} for %s rather than the malformed value', async (_l, bad) => {
      await seedUser(holder.db, USER_ID, bad);

      expect(await patchUserSettings(USER_ID, {})).toEqual({});
    });
  });

  describe('setAlertDismissed', () => {
    it.each(MALFORMED)(
      'succeeds over %s and leaves an object holding dismissedAlerts',
      async (_label, bad) => {
        await seedUser(holder.db, USER_ID, bad);

        const dismissed = await setAlertDismissed(USER_ID, 'notice-a', true);
        const stored = await readSettings(holder.db, USER_ID);

        expect(dismissed).toEqual(['notice-a']);
        expect(isPlainObject(stored)).toBe(true);
        expect(stored).toEqual({ dismissedAlerts: ['notice-a'] });
      }
    );

    /** CONTROL — a well-formed object keeps its sibling keys through the dismissal. */
    it('keeps sibling keys of a well-formed object', async () => {
      await seedUser(holder.db, USER_ID, { allowAds: false, dismissedAlerts: ['old'] });

      await setAlertDismissed(USER_ID, 'notice-a', true);

      expect(await readSettings(holder.db, USER_ID)).toEqual({
        allowAds: false,
        dismissedAlerts: ['old', 'notice-a'],
      });
    });
  });

  describe('the settings cache lookup', () => {
    it.each(MALFORMED)('surfaces no keys at all for %s', async (_label, bad) => {
      await seedUser(holder.db, USER_ID, bad);

      const settings = await getUserSettings(USER_ID);

      // Spreading an array would surface `"0"`, `"1"`, … and spreading a string its
      // characters; either way there would be keys here.
      expect(Object.keys(settings)).toEqual([]);
    });

    it('still carries the User-column preferences alongside an array settings value', async () => {
      await seedUser(holder.db, USER_ID, [null, { allowAds: false }]);

      const content = await getUserContentSettings(USER_ID);

      expect(Object.keys(content).sort()).toEqual(['autoplayGifs', 'blurNsfw', 'showNsfw']);
      expect(content).toMatchObject({ showNsfw: false, blurNsfw: true });
    });

    /** CONTROL — a well-formed object is surfaced as-is. */
    it('surfaces a well-formed object unchanged', async () => {
      await seedUser(holder.db, USER_ID, { allowAds: false, dismissedAlerts: ['x'] });

      expect(await getUserSettings(USER_ID)).toEqual({ allowAds: false, dismissedAlerts: ['x'] });
    });
  });
});
