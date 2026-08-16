import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
 * Lost-update tests for the `User.settings` JSON column.
 *
 * `settings` holds independent concerns — notice dismissals, feature toggles,
 * content preferences, tour progress — behind a single column. Every writer used
 * to read the blob into JS, compute a new object and write that object back, so
 * two writers overlapping meant the later write restored every key the earlier
 * one had just changed.
 *
 * Each test below drives the REAL handler/service against a real Postgres and
 * suspends one statement at the wire so the other request runs strictly between
 * the first request's read and its write. See the harness header for what this
 * does and does not model.
 */

// `~/server/db/client` is mocked canonically in src/__tests__/setup.ts (a per-file
// `vi.mock` of it freezes that shape into every later file in the same worker — see
// no-direct-shared-module-mock.test.ts). So the PGlite bridge is installed as BEHAVIOUR on
// the canonical node's stable spies rather than by replacing the module.
const holder = {
  db: null as unknown as PGlite,
  gate: null as unknown as Gate,
  bridge: null as unknown as ReturnType<typeof createPrismaBridge>,
};

/** Point every raw/model method the settings writers use at the PGlite bridge. */
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

// The settings cache is Redis-backed with a 4h TTL. Replace it with a pass-through so
// every read reaches Postgres — a cached read would hide the race behind cache timing
// instead of measuring it, and a stale cache is a SEPARATE defect (see the PR body).
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: vi.fn((opts: { lookupFn: (ids: number[]) => Promise<unknown> }) => ({
    fetch: async (ids: number | number[]) =>
      opts.lookupFn(Array.isArray(ids) ? ids : [ids]) as Promise<Record<string, unknown>>,
    bust: async () => undefined,
    refresh: async () => undefined,
    flush: async () => undefined,
  })),
}));

vi.mock('~/server/services/creator-membership.service', () => ({
  bustUserMetricPrivacyDefaultsCache: vi.fn(async () => undefined),
}));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn(async () => undefined),
  invalidateSession: vi.fn(async () => undefined),
}));
vi.mock('~/server/metrics', () => ({
  articleMetrics: { queueUpdate: vi.fn() },
  imageMetrics: { queueUpdate: vi.fn() },
  modelMetrics: { queueUpdate: vi.fn() },
  postMetrics: { queueUpdate: vi.fn() },
  userMetrics: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenModels: { refreshCache: vi.fn(async () => undefined) },
  HiddenModels3D: { refreshCache: vi.fn(async () => undefined) },
  HiddenUsers: { refreshCache: vi.fn(async () => undefined) },
  HiddenImages: { refreshCache: vi.fn(async () => undefined) },
  HiddenTags: { refreshCache: vi.fn(async () => undefined) },
  BlockedUsers: { refreshCache: vi.fn(async () => undefined), getCached: vi.fn(async () => []) },
  BlockedByUsers: { refreshCache: vi.fn(async () => undefined) },
  ImplicitHiddenImages: { refreshCache: vi.fn(async () => undefined) },
  toggleHidden: vi.fn(async () => ({ added: [], removed: [] })),
}));

import {
  dismissAlertHandler,
  restoreAlertHandler,
  setUserSettingHandler,
  toggleUserFeatureFlagHandler,
} from '~/server/controllers/user.controller';
import { toggleableFeatures } from '~/server/services/feature-flags.service';
import { updateContentSettings } from '~/server/services/user.service';

const USER_ID = 4242;
const ctx = { user: { id: USER_ID } } as Parameters<typeof dismissAlertHandler>[0]['ctx'];

// The whole-blob settings write, in both the pre-fix and post-fix statement shapes:
// `UPDATE "User" SET settings = …` WITHOUT `jsonb_set`, which is what distinguishes it
// from the dismissed-alerts write. Matching a shape both revisions emit is deliberate —
// the same test then means the same thing on either side of the fix.
const isSettingsWrite = (sql: string) =>
  /UPDATE\s+"User"\s+SET\s+settings/.test(sql) && !sql.includes('jsonb_set');
const isAlertWrite = (sql: string) => sql.includes('jsonb_set');
// Any write to the column, whichever statement shape the revision under test emits.
// The restore path changed shape in this fix (whole-blob merge → set operation), so a
// shape-specific matcher would miss it on one side and fail for a harness reason
// instead of on the data.
const isAnySettingsWrite = (sql: string) => /UPDATE\s+"User"\s+SET\s+settings/.test(sql);

const alerts = (s: Record<string, unknown>) => (s.dismissedAlerts ?? []) as string[];

/**
 * Wait for the held statement to arrive, but surface a request that FAILED or that
 * finished without ever emitting a matching statement. Awaiting `hold.reached` alone
 * turns either of those into a 60s timeout, which reads as "the race test is flaky"
 * rather than naming the harness or handler fault that actually occurred.
 */
async function reach(hold: { reached: Promise<void> }, inflight: Promise<unknown>) {
  await Promise.race([
    hold.reached,
    inflight.then(() => {
      throw new Error('in-flight request finished without its write reaching the gate');
    }),
  ]);
}

describe('User.settings — concurrent writers must not discard each other', () => {
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
  });

  it('keeps a dismissal that lands while a content-settings write is in flight', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: ['already-dismissed'] });

    // Hold the content-settings UPDATE. Its read has already happened by the time the
    // statement reaches the wire, so the dismissal below runs strictly in between.
    const hold = holder.gate.hold(isSettingsWrite);
    const settingsWrite = updateContentSettings({ userId: USER_ID, allowAds: true });
    await reach(hold, settingsWrite);

    await dismissAlertHandler({ input: { alertId: 'notice-b', dismiss: true }, ctx });

    hold.release();
    await settingsWrite;

    const settings = await readSettings(holder.db, USER_ID);
    // Pre-fix: the content-settings write carried the whole read snapshot, so
    // `dismissedAlerts` went back to what it was before `notice-b` was dismissed and
    // the notice reappeared for the user.
    expect(alerts(settings)).toEqual(expect.arrayContaining(['already-dismissed', 'notice-b']));
    // …and the setting the other request was actually making must still be there.
    expect(settings.allowAds).toBe(true);
  });

  it('keeps a content-settings write that lands while a dismissal is in flight', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: [] });

    const hold = holder.gate.hold(isAlertWrite);
    const dismiss = dismissAlertHandler({
      input: { alertId: 'notice-c', dismiss: true },
      ctx,
    });
    await reach(hold, dismiss);

    await updateContentSettings({ userId: USER_ID, allowAds: true });

    hold.release();
    await dismiss;

    const settings = await readSettings(holder.db, USER_ID);
    expect(alerts(settings)).toContain('notice-c');
    // The dismissal writes only its own key, so the other request's setting survives on
    // both revisions. This half is an INVARIANT GUARD, not regression coverage — it
    // pins that the narrow write stays narrow.
    expect(settings.allowAds).toBe(true);
  });

  it('keeps both of two dismissals that overlap', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: [] });

    const hold = holder.gate.hold(isAlertWrite);
    const first = dismissAlertHandler({ input: { alertId: 'notice-x', dismiss: true }, ctx });
    await reach(hold, first);

    await dismissAlertHandler({ input: { alertId: 'notice-y', dismiss: true }, ctx });

    hold.release();
    await first;

    const settings = await readSettings(holder.db, USER_ID);
    // Pre-fix: the first request computed its array from a snapshot taken before
    // `notice-y` existed and wrote that array wholesale, so `notice-y` was erased.
    expect(alerts(settings).sort()).toEqual(['notice-x', 'notice-y']);
  });

  it('keeps a dismissal that overlaps a restore of a different notice', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: ['notice-p', 'notice-q'] });

    const hold = holder.gate.hold(isAnySettingsWrite);
    const restore = restoreAlertHandler({ input: { alertId: 'notice-p' }, ctx });
    await reach(hold, restore);

    await dismissAlertHandler({ input: { alertId: 'notice-r', dismiss: true }, ctx });

    hold.release();
    await restore;

    const settings = await readSettings(holder.db, USER_ID);
    expect(alerts(settings).sort()).toEqual(['notice-q', 'notice-r']);
  });

  it('keeps a dismissal that lands while user.setSettings is in flight', async () => {
    // Seeded NON-EMPTY on purpose. `setUserSetting` ran its payload through `removeEmpty`,
    // which drops an empty array — so a user with no prior dismissals could not show this
    // loss at all, and an empty fixture would pass on the pre-fix code for a reason that
    // has nothing to do with the fix.
    await seedUser(holder.db, USER_ID, { dismissedAlerts: ['already-dismissed'] });

    // The collision that made this reachable in normal use: `isEarlyAdopter` is written
    // through `user.setSettings`, which read and rewrote the whole blob.
    const hold = holder.gate.hold(isSettingsWrite);
    const setSettings = setUserSettingHandler({ input: { isEarlyAdopter: true }, ctx });
    await reach(hold, setSettings);

    await dismissAlertHandler({ input: { alertId: 'notice-z', dismiss: true }, ctx });

    hold.release();
    await setSettings;

    const settings = await readSettings(holder.db, USER_ID);
    expect(alerts(settings).sort()).toEqual(['already-dismissed', 'notice-z']);
    expect(settings.isEarlyAdopter).toBe(true);
  });

  it('keeps a dismissal that lands while a feature toggle is in flight', async () => {
    // Read the key from the registry rather than naming one, so retiring a flag cannot
    // silently turn this into a test of nothing.
    const feature = toggleableFeatures[0].key;
    await seedUser(holder.db, USER_ID, {
      dismissedAlerts: ['already-dismissed'],
      features: { [feature]: false },
    });

    const hold = holder.gate.hold(isSettingsWrite);
    const toggle = toggleUserFeatureFlagHandler({ input: { feature, value: true }, ctx });
    await reach(hold, toggle);

    await dismissAlertHandler({ input: { alertId: 'notice-w', dismiss: true }, ctx });

    hold.release();
    await toggle;

    const settings = await readSettings(holder.db, USER_ID);
    expect(alerts(settings).sort()).toEqual(['already-dismissed', 'notice-w']);
    expect((settings.features as Record<string, boolean>)[feature]).toBe(true);
  });

  it('keeps a feature toggle that lands while another feature toggle is in flight', async () => {
    const [a, b] = toggleableFeatures;
    if (!b) return; // registry has a single toggleable flag; nothing to interleave
    await seedUser(holder.db, USER_ID, { features: { [a.key]: false, [b.key]: false } });

    const hold = holder.gate.hold(isSettingsWrite);
    const first = toggleUserFeatureFlagHandler({ input: { feature: a.key, value: true }, ctx });
    await reach(hold, first);

    await toggleUserFeatureFlagHandler({ input: { feature: b.key, value: true }, ctx });

    hold.release();
    await first;

    const features = (await readSettings(holder.db, USER_ID)).features as Record<string, boolean>;
    expect(features[a.key]).toBe(true);
    expect(features[b.key]).toBe(true);
  });
});

describe('User.settings — single-request behaviour the writers must keep', () => {
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
  });

  it('restores the LAST remaining dismissal', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: ['only-one'], allowAds: true });

    await restoreAlertHandler({ input: { alertId: 'only-one' }, ctx });

    const settings = await readSettings(holder.db, USER_ID);
    // Pre-fix this wrote NOTHING: the handler passed `{ dismissedAlerts: [] }` through
    // the whole-blob merge, whose `removeEmpty` drops an empty array, leaving an empty
    // payload and an early return. The notice stayed hidden forever.
    expect(alerts(settings)).toEqual([]);
    expect(settings.allowAds).toBe(true);
  });

  // INVARIANT GUARD (green on the pre-change code too): the JS `new Set` deduped as well.
  // It pins that moving the dedupe into SQL kept the property.
  it('is idempotent — dismissing the same notice twice stores it once', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: [] });

    await dismissAlertHandler({ input: { alertId: 'notice-d', dismiss: true }, ctx });
    await dismissAlertHandler({ input: { alertId: 'notice-d', dismiss: true }, ctx });

    expect(alerts(await readSettings(holder.db, USER_ID))).toEqual(['notice-d']);
  });

  // `dismissAlert({ dismiss: false })` is how the product actually un-dismisses a notice —
  // `user.restoreAlert` has no caller in this repo. Without these two cases a handler that
  // ignored `input.dismiss` and always dismissed passed the whole suite (mutation M16).
  it('un-dismisses through dismissAlert({ dismiss: false })', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: ['notice-g', 'notice-h'] });

    await dismissAlertHandler({ input: { alertId: 'notice-g', dismiss: false }, ctx });

    expect(alerts(await readSettings(holder.db, USER_ID))).toEqual(['notice-h']);
  });

  it('un-dismisses the LAST remaining notice through dismissAlert({ dismiss: false })', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: ['only-one'], allowAds: true });

    await dismissAlertHandler({ input: { alertId: 'only-one', dismiss: false }, ctx });

    const settings = await readSettings(holder.db, USER_ID);
    expect(alerts(settings)).toEqual([]);
    expect(settings.allowAds).toBe(true);
  });

  // INVARIANT GUARD (green on the pre-change code too). `COALESCE(settings, '{}')` is easy
  // to drop when rewriting the statement, and a NULL column is the default for a new user.
  it('dismisses onto a NULL settings column', async () => {
    await holder.db.query(
      `INSERT INTO "User" (id, settings) VALUES ($1, NULL)
                           ON CONFLICT (id) DO UPDATE SET settings = NULL`,
      [USER_ID]
    );

    await dismissAlertHandler({ input: { alertId: 'notice-e', dismiss: true }, ctx });

    expect(alerts(await readSettings(holder.db, USER_ID))).toEqual(['notice-e']);
  });

  it('self-heals a dismissedAlerts value that is not an array', async () => {
    // Nothing enforces a shape on a JSON column. `jsonb_array_elements` raises on a
    // non-array, so without the type guard one malformed row would 500 forever.
    await seedUser(holder.db, USER_ID, { dismissedAlerts: 'corrupt' as unknown as string[] });

    await dismissAlertHandler({ input: { alertId: 'notice-f', dismiss: true }, ctx });
    expect(alerts(await readSettings(holder.db, USER_ID))).toEqual(['notice-f']);

    await seedUser(holder.db, USER_ID, { dismissedAlerts: 'corrupt' as unknown as string[] });
    await restoreAlertHandler({ input: { alertId: 'notice-f' }, ctx });
    expect(alerts(await readSettings(holder.db, USER_ID))).toEqual([]);
  });

  // INVARIANT GUARD (green on the pre-change code too): pins that the SQL filter removes
  // exactly the named id, matching the JS `.filter()` it replaced.
  it('leaves unrelated notices alone when one is restored', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: ['a', 'b', 'c'] });

    await restoreAlertHandler({ input: { alertId: 'b' }, ctx });

    expect(alerts(await readSettings(holder.db, USER_ID))).toEqual(['a', 'c']);
  });
});
