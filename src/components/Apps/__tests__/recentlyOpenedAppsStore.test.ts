import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecentlyOpenedApps,
  getRecentlyOpenedApps,
  MAX_RECENTS,
  MAX_RECENTS_TOTAL,
  recordRecentlyOpenedApp,
  RECENTLY_OPENED_APPS_KEY,
  type RecentApp,
} from '~/components/Apps/recentlyOpenedAppsStore';
import { resolveRecentApp } from '~/components/Apps/recentAppsRail';

/**
 * `recentlyOpenedApps` localStorage store — node `unit` project.
 *
 * 🔴 WHY THIS IS HERE AND NOT ONLY IN THE BROWSER SUITE. This is the one module
 * in the `/apps` recents feature that parses UNTRUSTED, USER-WRITABLE input: the
 * whole v3 validation layer (`coerce`) exists because anybody can hand-edit
 * `localStorage.recentlyOpenedApps` and every previously-shipped entry shape is
 * still in the wild. The existing coverage lived only in
 * `recents-helper.browser.test.tsx` — and CI does not run the browser
 * (`component`) project AT ALL (no Chromium), so on a PR nothing was watching
 * that validation. The `unit` project at least runs on every PR
 * (`.github/workflows/lint.yml`), which is why behavioural coverage belongs
 * here; the browser suite keeps its real-`window` prepend/dedup/cap coverage.
 *
 * 🔴 DON'T READ THAT AS "THIS BLOCKS A MERGE" — it does not. The `Unit tests`
 * job carries `continue-on-error: true`, so a red test annotates and merges.
 * The only merge-blocking steps today are Typecheck, the "migrations are in the
 * schema package" check, and ESLint/Prettier over ADDED files. Running on every
 * PR is the value here; enforcement is not.
 *
 * The store is SSR-safe via `isClient()`, so a node test has to supply a
 * `window.localStorage`. A minimal in-memory Storage is enough — the store only
 * uses getItem / setItem / removeItem.
 */

class MemoryStorage {
  private map = new Map<string, string>();
  /** Set to true to simulate a quota / private-mode write throw. */
  throwOnSet = false;
  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new Error('QuotaExceededError');
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

let storage: MemoryStorage;

/** Write a RAW blob straight into the store, bypassing the write gate — this is
 *  the shape a hand-edited / legacy localStorage actually presents on read. */
function seedRaw(value: unknown) {
  storage.setItem(
    RECENTLY_OPENED_APPS_KEY,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
}

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { window?: unknown }).window = { localStorage: storage };
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('SSR safety', () => {
  it('every entry point no-ops with no window (the /apps page renders server-side first)', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(getRecentlyOpenedApps()).toEqual([]);
    expect(recordRecentlyOpenedApp({ id: 'a', blockId: 'a' })).toEqual([]);
    expect(() => clearRecentlyOpenedApps()).not.toThrow();
  });
});

describe('coerce — the untrusted-input validation layer', () => {
  it('a non-array blob reads as [] (object / string / number / null)', () => {
    for (const bad of [{ id: 'a' }, '"a string"', '42', 'null']) {
      seedRaw(bad);
      expect(getRecentlyOpenedApps()).toEqual([]);
    }
  });

  it('unparseable JSON reads as [] (fail-soft, never throws into the page)', () => {
    seedRaw('{ not valid json');
    expect(getRecentlyOpenedApps()).toEqual([]);
  });

  it('drops non-object array members without dropping their neighbours', () => {
    seedRaw([null, 'str', 7, { id: 'ok', blockId: 'ok' }, undefined]);
    expect(getRecentlyOpenedApps().map((e) => e.id)).toEqual(['ok']);
  });

  it('requires a STRING id', () => {
    seedRaw([{ id: 1, blockId: 'x' }, { id: null, blockId: 'x' }, { blockId: 'x' }]);
    expect(getRecentlyOpenedApps()).toEqual([]);
  });

  it('drops an entry with no navigable handle at all', () => {
    seedRaw([{ id: 'a' }, { id: 'b', blockId: '' }, { id: 'c', slug: '' }]);
    expect(getRecentlyOpenedApps()).toEqual([]);
  });

  it('carries a LEGACY v1 {id, blockId} entry through untouched', () => {
    seedRaw([{ id: 'ab_9', blockId: 'legacy-app' }]);
    expect(getRecentlyOpenedApps()).toEqual([{ id: 'ab_9', blockId: 'legacy-app' }]);
  });

  it('an unknown `kind` value degrades to "no kind" rather than flowing into link logic', () => {
    seedRaw([{ id: 'a', blockId: 'a', kind: 'sideways' }]);
    expect(getRecentlyOpenedApps()[0].kind).toBeUndefined();
  });

  it('wrong-typed enrichment fields are dropped, not carried (no crash, less enrichment)', () => {
    seedRaw([
      {
        id: 'a',
        blockId: 'a',
        hasPage: 'true',
        externalUrl: 42,
        name: { evil: true },
        iconUrl: ['x'],
      },
    ]);
    expect(getRecentlyOpenedApps()).toEqual([{ id: 'a', blockId: 'a' }]);
  });

  it('🔴 a stringy `hasPage` cannot survive into the rail as "this app has a page"', () => {
    // End-to-end version of the same guard: user-writable value → store → rail.
    seedRaw([{ id: 'a', blockId: 'gen', slug: 'gen', kind: 'onsite', hasPage: 'true' }]);
    const [entry] = getRecentlyOpenedApps();
    expect(entry.hasPage).toBeUndefined();
    expect(resolveRecentApp(entry)!.hasPage).toBe(false);
  });
});

describe('🔴 the write gate and the read gate are the SAME gate', () => {
  // The bug this pins: `coerce` accepted `{id, blockId, kind:'offsite'}`, but
  // `resolveRecentApp` requires a `slug` for an off-site entry — so the value
  // persisted and then silently vanished on the next read.
  it('rejects an off-site entry with no slug on WRITE (blockId cannot stand in)', () => {
    const next = recordRecentlyOpenedApp({
      id: 'x',
      blockId: 'not-a-listing-slug',
      kind: 'offsite',
    });
    expect(next).toEqual([]);
    expect(getRecentlyOpenedApps()).toEqual([]);
  });

  it('drops the same shape on READ', () => {
    seedRaw([{ id: 'x', blockId: 'not-a-listing-slug', kind: 'offsite' }]);
    expect(getRecentlyOpenedApps()).toEqual([]);
  });

  it('anything the store ACCEPTS is resolvable by the rail — no silent read-side drop', () => {
    const candidates: RecentApp[] = [
      { id: 'a', blockId: 'a' }, // legacy v1
      { id: 'b', slug: 'b' }, // slug-only
      { id: 'c', blockId: 'c', slug: 'c', kind: 'onsite', hasPage: true },
      { id: 'd', slug: 'd', kind: 'offsite', externalUrl: 'https://ext.example' },
      { id: 'e', slug: 'e', kind: 'offsite' }, // off-site, no external url
      { id: 'f', blockId: 'f', slug: 'f', kind: 'offsite' }, // both handles
    ];
    for (const candidate of candidates) {
      clearRecentlyOpenedApps();
      const accepted = recordRecentlyOpenedApp(candidate);
      if (accepted.length === 0) continue; // rejected on write — fine
      expect(
        resolveRecentApp(accepted[0]),
        `accepted but unresolvable: ${candidate.id}`
      ).not.toBeNull();
    }
  });

  it('an off-site entry WITH a slug round-trips (write → read → resolve)', () => {
    recordRecentlyOpenedApp({
      id: 'lst_1',
      slug: 'ext-app',
      kind: 'offsite',
      externalUrl: 'https://ext.example/app',
    });
    const [entry] = getRecentlyOpenedApps();
    expect(entry.slug).toBe('ext-app');
    expect(resolveRecentApp(entry)).toMatchObject({ slug: 'ext-app', kind: 'offsite' });
  });
});

describe('🔴 per-kind budget — one kind can never starve the other', () => {
  const onsite = (n: number): RecentApp => ({
    id: `on-${n}`,
    blockId: `on-${n}`,
    slug: `on-${n}`,
    kind: 'onsite',
    hasPage: true,
  });
  const offsite = (n: number): RecentApp => ({
    id: `off-${n}`,
    slug: `off-${n}`,
    kind: 'offsite',
    externalUrl: 'https://ext.example',
  });

  it('off-site traffic does NOT evict on-site entries (the app-chrome menu keeps its supply)', () => {
    // The regression: with a single flat cap, opening MAX_RECENTS off-site apps
    // emptied the app-chrome "Recently run" menu, which can only render on-site
    // entries — an unflagged behaviour change to a pre-existing feature.
    recordRecentlyOpenedApp(onsite(1));
    for (let i = 0; i < MAX_RECENTS + 4; i++) recordRecentlyOpenedApp(offsite(i));

    const list = getRecentlyOpenedApps();
    const onsiteEntries = list.filter((e) => e.kind !== 'offsite' && !!e.blockId);
    expect(onsiteEntries.map((e) => e.id)).toEqual(['on-1']);
  });

  it('and symmetrically: on-site traffic does not evict off-site entries', () => {
    recordRecentlyOpenedApp(offsite(1));
    for (let i = 0; i < MAX_RECENTS + 4; i++) recordRecentlyOpenedApp(onsite(i));
    expect(
      getRecentlyOpenedApps()
        .filter((e) => e.kind === 'offsite')
        .map((e) => e.id)
    ).toEqual(['off-1']);
  });

  it('each kind is still capped at MAX_RECENTS, oldest-first eviction', () => {
    for (let i = 0; i < MAX_RECENTS + 3; i++) recordRecentlyOpenedApp(onsite(i));
    const ids = getRecentlyOpenedApps().map((e) => e.id);
    expect(ids).toHaveLength(MAX_RECENTS);
    expect(ids[0]).toBe(`on-${MAX_RECENTS + 2}`); // newest first
    expect(ids).not.toContain('on-0');
  });

  it('the whole list is bounded by MAX_RECENTS_TOTAL', () => {
    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      recordRecentlyOpenedApp(onsite(i));
      recordRecentlyOpenedApp(offsite(i));
    }
    expect(getRecentlyOpenedApps().length).toBe(MAX_RECENTS_TOTAL);
    expect(MAX_RECENTS_TOTAL).toBe(MAX_RECENTS * 2);
  });

  it('a legacy entry with NO kind counts against the ON-SITE budget (it is on-site by construction)', () => {
    seedRaw(
      Array.from({ length: MAX_RECENTS + 3 }, (_, i) => ({ id: `l-${i}`, blockId: `l-${i}` }))
    );
    expect(getRecentlyOpenedApps()).toHaveLength(MAX_RECENTS);
  });

  it('the READ caps too, so a blob written by an older (flat-cap) build is still bounded', () => {
    seedRaw([
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `on-${i}`,
        blockId: `on-${i}`,
        kind: 'onsite',
      })),
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `off-${i}`,
        slug: `off-${i}`,
        kind: 'offsite',
      })),
    ]);
    const list = getRecentlyOpenedApps();
    expect(list.filter((e) => e.kind === 'onsite')).toHaveLength(MAX_RECENTS);
    expect(list.filter((e) => e.kind === 'offsite')).toHaveLength(MAX_RECENTS);
  });
});

describe('ordering + dedupe + fail-soft write', () => {
  const app = (id: string): RecentApp => ({ id, blockId: `block-${id}` });

  it('prepends newest-first', () => {
    recordRecentlyOpenedApp(app('a'));
    recordRecentlyOpenedApp(app('b'));
    expect(getRecentlyOpenedApps().map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('re-recording moves to the front without duplicating', () => {
    recordRecentlyOpenedApp(app('a'));
    recordRecentlyOpenedApp(app('b'));
    recordRecentlyOpenedApp(app('a'));
    expect(getRecentlyOpenedApps().map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('a quota / private-mode write throw is swallowed and still returns the in-memory list', () => {
    storage.throwOnSet = true;
    expect(recordRecentlyOpenedApp(app('a')).map((e) => e.id)).toEqual(['a']);
    // …but nothing was persisted.
    storage.throwOnSet = false;
    expect(getRecentlyOpenedApps()).toEqual([]);
  });

  it('clear empties the store', () => {
    recordRecentlyOpenedApp(app('a'));
    clearRecentlyOpenedApps();
    expect(getRecentlyOpenedApps()).toEqual([]);
  });
});
