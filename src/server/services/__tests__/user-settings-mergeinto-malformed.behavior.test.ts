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
 * `patchUserSettings({ mergeInto })` against a MALFORMED stored key.
 *
 * 🔴 WHY THIS IS NOT PARANOIA ABOUT OUR OWN WRITERS. `settings` is a plain JSONB column;
 * nothing in Postgres enforces that `settings->'chat'` is an object. And the merge
 * operator does not reject a non-object — `jsonb || jsonb` CONCATENATES, so a stored
 * `{"chat": 7}` merges to `{"chat": [7, {...}]}`, an ARRAY. No statement raises, nothing
 * on the request path notices, and every subsequent write appends another element:
 * unbounded growth in the column, and `chat.*` reads that are permanently undefined for
 * that user.
 *
 * 🔴 THE DIRECTION IS THE POINT. The whole-key `set` this primitive replaced was
 * SELF-HEALING — it overwrote the bad value, so one malformed row repaired itself on the
 * next write. An unguarded merge is SELF-WORSENING. Replacing a self-healing write with a
 * self-worsening one is a regression in failure mode even while no row is malformed, and
 * `mergeInto` is now the designated nested-write primitive for `chat`, `features`,
 * `creatorShop`, `gallerySettings` and `tourSettings` — so the gap would be inherited
 * five times over.
 *
 * Sampled production rows are 100% objects for every key written this way, so this is
 * hardening rather than a live fix. That is exactly why it is worth pinning now: the
 * cheapest moment to fix a data-shape hazard is before any row has the shape.
 *
 * SCOPE. These run the statement the service actually emits against a real Postgres
 * (PGlite), not a hand-written fake of `jsonb ||` — a fake would only re-encode whatever
 * the test author believed the operator does, which is the very belief under test here.
 * No interleaving is needed: this is a property of a single write over a stored value.
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

const { patchUserSettings } = await import('~/server/services/user.service');

const USER_ID = 5150;

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

describe('patchUserSettings mergeInto — a malformed stored key must not become an array', () => {
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

  /**
   * REGRESSION. Each of these is a JSON value that is not an object, which is precisely
   * the set `jsonb ||` concatenates instead of merging. `null` is in the table on purpose
   * and is the likeliest of them in real data — a `COALESCE(settings->'chat', '{}')`
   * guard does NOT catch it, because the key is PRESENT and its value is JSON null, so
   * `->` returns a non-SQL-NULL jsonb. That is the case that separates the two guards.
   */
  it.each([
    ['a number', 7],
    ['a string', 'nope'],
    ['JSON null', null],
    ['a boolean', true],
    ['an array', [1, 2]],
  ])('repairs %s stored under the merged key instead of concatenating onto it', async (_l, bad) => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: ['keep-me'], chat: bad });

    const returned = await patchUserSettings(USER_ID, {
      mergeInto: { chat: { muteSounds: true } },
      location: 'test',
    });

    const stored = await readSettings(holder.db, USER_ID);
    for (const settings of [returned as Record<string, unknown>, stored]) {
      const chat = settings.chat;
      // Assert the STATE — a plain object carrying the written key — rather than
      // "not an array". A `string` or a `number` survivor is equally wrong and would
      // walk a negative assertion.
      expect(Array.isArray(chat)).toBe(false);
      expect(chat).toEqual({ muteSounds: true });
    }
    // The guard must repair the malformed key WITHOUT touching its siblings.
    expect(stored.dismissedAlerts).toEqual(['keep-me']);
  });

  /**
   * CONTROL 1 — the guard must not fire on the ordinary case. Without this, an
   * implementation that simply discarded the stored value on every merge would pass
   * every assertion above while silently destroying real settings on each write.
   */
  it('merges onto a well-formed object without discarding its other keys', async () => {
    await seedUser(holder.db, USER_ID, {
      chat: { acknowledged: true, replaceBadWords: false },
    });

    const returned = (await patchUserSettings(USER_ID, {
      mergeInto: { chat: { muteSounds: true } },
      location: 'test',
    })) as Record<string, unknown>;

    // acknowledged survives (stored side), muteSounds lands (patch side), and
    // replaceBadWords keeps its stored value rather than reverting to a default —
    // three distinct values, so operand order and wholesale-replacement both show up.
    expect(returned.chat).toEqual({ acknowledged: true, replaceBadWords: false, muteSounds: true });
  });

  /**
   * CONTROL 2 — an ABSENT key still initialises. This is the case the original
   * `COALESCE` existed for, so it must keep working; a guard written as a bare
   * `jsonb_typeof(...) = 'object'` with no fallback would regress it to a SQL NULL and
   * wipe the whole settings object.
   */
  it('initialises a key that is absent entirely', async () => {
    await seedUser(holder.db, USER_ID, { dismissedAlerts: ['keep-me'] });

    const returned = (await patchUserSettings(USER_ID, {
      mergeInto: { chat: { muteSounds: true } },
      location: 'test',
    })) as Record<string, unknown>;

    expect(returned.chat).toEqual({ muteSounds: true });
    expect(returned.dismissedAlerts).toEqual(['keep-me']);
  });

  /**
   * The self-healing property stated as behaviour rather than as a comment: a second
   * write over a repaired row is an ordinary merge. This is what distinguishes the
   * guard from one that merely avoids erroring — the row is genuinely usable again.
   */
  it('leaves the row healed, so the next write merges normally', async () => {
    await seedUser(holder.db, USER_ID, { chat: 7 });

    await patchUserSettings(USER_ID, { mergeInto: { chat: { muteSounds: true } } });
    const returned = (await patchUserSettings(USER_ID, {
      mergeInto: { chat: { acknowledged: true } },
    })) as Record<string, unknown>;

    expect(returned.chat).toEqual({ muteSounds: true, acknowledged: true });
  });
});
