import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearRecentlyOpenedApps,
  getRecentlyOpenedApps,
  MAX_RECENTS,
  recordRecentlyOpenedApp,
  RECENTLY_OPENED_APPS_KEY,
  RECENTS_ENVELOPE_VERSION,
  type RecentApp,
} from '~/components/Apps/recentlyOpenedAppsStore';

/**
 * `recentlyOpenedApps` localStorage helper — runs in browser mode so a REAL
 * `window.localStorage` is present (the helper no-ops on the server, so a node
 * unit test couldn't exercise the cap/dedup/order logic at all).
 *
 * Contract under test (each reverted property fails a case):
 *  - newest-first prepend
 *  - de-dup by id (re-record MOVES to front, no duplicate)
 *  - capped at MAX_RECENTS
 *  - tolerant read of a corrupt store (→ [])
 */

const app = (id: string): RecentApp => ({ id, blockId: `block-${id}` });

/** The account these cases read/write as. Recents are ACCOUNT-scoped (#4048),
 *  so every entry point takes the viewer's id (`null` = signed out). */
const OWNER = 42;
const OTHER_OWNER = 43;

/** Seed a well-formed owner-stamped blob, bypassing the write gate — the shape
 *  a hand-edited localStorage presents on read. A BARE array is the pre-owner
 *  shape and is dropped wholesale, so seeding one would make these cases pass
 *  vacuously. */
function seedOwned(apps: unknown, ownerId: number | null = OWNER) {
  window.localStorage.setItem(
    RECENTLY_OPENED_APPS_KEY,
    JSON.stringify({ v: RECENTS_ENVELOPE_VERSION, ownerId, apps })
  );
}

beforeEach(() => {
  clearRecentlyOpenedApps();
});

describe('recentlyOpenedApps helper', () => {
  test('empty store reads as []', () => {
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  test('record prepends newest-first', () => {
    recordRecentlyOpenedApp(app('a'), OWNER);
    recordRecentlyOpenedApp(app('b'), OWNER);
    recordRecentlyOpenedApp(app('c'), OWNER);
    expect(getRecentlyOpenedApps(OWNER).map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  test('re-recording an existing id de-dups and moves it to the front (no duplicate)', () => {
    recordRecentlyOpenedApp(app('a'), OWNER);
    recordRecentlyOpenedApp(app('b'), OWNER);
    recordRecentlyOpenedApp(app('a'), OWNER); // re-open 'a'
    const ids = getRecentlyOpenedApps(OWNER).map((r) => r.id);
    expect(ids).toEqual(['a', 'b']);
    // exactly one 'a' (deduped)
    expect(ids.filter((x) => x === 'a')).toHaveLength(1);
  });

  test('caps the list at MAX_RECENTS, dropping the oldest', () => {
    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      recordRecentlyOpenedApp(app(`app-${i}`), OWNER);
    }
    const list = getRecentlyOpenedApps(OWNER);
    expect(list).toHaveLength(MAX_RECENTS);
    // newest (last recorded) is at the front; the first MAX_RECENTS-5 are dropped
    expect(list[0].id).toBe(`app-${MAX_RECENTS + 4}`);
    expect(list.map((r) => r.id)).not.toContain('app-0');
  });

  test('record returns the updated list', () => {
    const next = recordRecentlyOpenedApp(app('x'), OWNER);
    expect(next.map((r) => r.id)).toEqual(['x']);
  });

  test('a corrupt store value reads as [] (fail-soft)', () => {
    window.localStorage.setItem(RECENTLY_OPENED_APPS_KEY, '{ not valid json');
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  test('malformed entries are dropped on read', () => {
    seedOwned([{ id: 'ok', blockId: 'b-ok' }, { id: 123 }, null, 'nope']);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([{ id: 'ok', blockId: 'b-ok' }]);
  });

  // Display-enrichment fields (name/iconUrl) — round-trip + backward-compat.
  test('name + iconUrl are persisted and round-tripped', () => {
    recordRecentlyOpenedApp(
      {
        id: 'rich',
        blockId: 'block-rich',
        name: 'Background Remover',
        iconUrl: 'https://cdn.example/icon.png',
      },
      OWNER
    );
    expect(getRecentlyOpenedApps(OWNER)).toEqual([
      {
        id: 'rich',
        blockId: 'block-rich',
        name: 'Background Remover',
        iconUrl: 'https://cdn.example/icon.png',
      },
    ]);
  });

  test('a legacy {id,blockId}-only stored entry still parses (backward-compat)', () => {
    // Simulate an entry written BEFORE name/iconUrl existed — it must survive a
    // read unchanged (no name/iconUrl keys invented), proving the widened type
    // is backward-compatible with already-persisted data.
    seedOwned([{ id: 'legacy', blockId: 'block-legacy' }]);
    const list = getRecentlyOpenedApps(OWNER);
    expect(list).toEqual([{ id: 'legacy', blockId: 'block-legacy' }]);
    expect(list[0]).not.toHaveProperty('name');
    expect(list[0]).not.toHaveProperty('iconUrl');
  });

  test('wrong-typed name/iconUrl are dropped, id/blockId still parse (fail-soft)', () => {
    seedOwned([{ id: 'x', blockId: 'b-x', name: 42, iconUrl: { bad: true } }]);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([{ id: 'x', blockId: 'b-x' }]);
  });

  test('re-recording upgrades a legacy entry to the richer shape (dedup keeps newest)', () => {
    recordRecentlyOpenedApp({ id: 'up', blockId: 'block-up' }, OWNER);
    recordRecentlyOpenedApp(
      { id: 'up', blockId: 'block-up', name: 'Upgraded', iconUrl: 'i.png' },
      OWNER
    );
    const list = getRecentlyOpenedApps(OWNER);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({ id: 'up', blockId: 'block-up', name: 'Upgraded', iconUrl: 'i.png' });
  });

  // ── v3 shape: slug / kind / hasPage / externalUrl ───────────────────────────
  // The store widened so a recents entry can link to the unified store detail
  // (`/apps/store-preview/<slug>`) and so an OFF-SITE listing — which has no
  // AppBlock and therefore NO blockId at all — is representable.

  test('an OFF-SITE entry (slug, no blockId) round-trips', () => {
    recordRecentlyOpenedApp(
      {
        id: 'lst_1',
        slug: 'ext-app',
        kind: 'offsite',
        externalUrl: 'https://ext.example/app',
        name: 'Ext App',
      },
      OWNER
    );
    expect(getRecentlyOpenedApps(OWNER)).toEqual([
      {
        id: 'lst_1',
        slug: 'ext-app',
        kind: 'offsite',
        externalUrl: 'https://ext.example/app',
        name: 'Ext App',
      },
    ]);
  });

  test('an ON-SITE entry round-trips slug + kind + hasPage', () => {
    recordRecentlyOpenedApp(
      {
        id: 'ab_1',
        blockId: 'gen-matrix',
        slug: 'gen-matrix',
        kind: 'onsite',
        hasPage: true,
        name: 'Gen Matrix',
      },
      OWNER
    );
    expect(getRecentlyOpenedApps(OWNER)[0]).toEqual({
      id: 'ab_1',
      blockId: 'gen-matrix',
      slug: 'gen-matrix',
      kind: 'onsite',
      hasPage: true,
      name: 'Gen Matrix',
    });
  });

  test('an entry with NO navigable handle (no blockId, no slug) is dropped on read', () => {
    seedOwned([
      { id: 'handleless', name: 'Nowhere' },
      { id: 'ok', slug: 'somewhere' },
    ]);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([{ id: 'ok', slug: 'somewhere' }]);
  });

  test('the WRITE path applies the same gate — a handleless entry is not persisted', () => {
    recordRecentlyOpenedApp({ id: 'ok', slug: 'somewhere' }, OWNER);
    // A caller that forgot the handle — type-legal (every field but `id` is
    // optional), so only this runtime gate stops it becoming an unreadable row.
    recordRecentlyOpenedApp({ id: 'handleless', name: 'Nowhere' }, OWNER);
    expect(getRecentlyOpenedApps(OWNER).map((r) => r.id)).toEqual(['ok']);
  });

  test('a wrong-typed / unknown kind degrades to "no kind" (never flows on as a discriminant)', () => {
    seedOwned([{ id: 'x', slug: 's', kind: 'martian', hasPage: 'yes' }]);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([{ id: 'x', slug: 's' }]);
  });

  test('empty-string handles do not count as handles', () => {
    seedOwned([{ id: 'x', blockId: '', slug: '' }]);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });
});

/**
 * 🔴 The account-scoping guarantee against a REAL `window.localStorage` (#4048).
 * The node suite covers the same rules against an in-memory Storage; this is the
 * one that proves nothing in the browser's own implementation (serialization,
 * key handling) changes the answer.
 */
describe('account-scoped recents (real localStorage)', () => {
  test('a second account reads an empty list, and its own write does not merge', () => {
    recordRecentlyOpenedApp(app('mine'), OWNER);
    expect(getRecentlyOpenedApps(OTHER_OWNER)).toEqual([]);
    recordRecentlyOpenedApp(app('theirs'), OTHER_OWNER);
    expect(getRecentlyOpenedApps(OTHER_OWNER).map((r) => r.id)).toEqual(['theirs']);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  test('the signed-out bucket and a signed-in one are mutually invisible', () => {
    recordRecentlyOpenedApp(app('anon'), null);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
    expect(getRecentlyOpenedApps(null).map((r) => r.id)).toEqual(['anon']);
  });

  test('a pre-owner BARE ARRAY blob is dropped rather than inherited', () => {
    window.localStorage.setItem(
      RECENTLY_OPENED_APPS_KEY,
      JSON.stringify([{ id: 'inherited', blockId: 'moderator-only' }])
    );
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
    expect(getRecentlyOpenedApps(null)).toEqual([]);
  });
});
