import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRecentlyOpenedApps,
  getRecentlyOpenedApps,
  MAX_RECENTS,
  MAX_RECENTS_TOTAL,
  recordRecentlyOpenedApp,
  RECENTLY_OPENED_APPS_KEY,
  RECENTS_ENVELOPE_VERSION,
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
 * `recents-helper.browser.test.tsx` — and the browser (`component`) project runs
 * only in the PR preview pipeline, report-only and behind a preview build that
 * fails intermittently, so on a PR very little was reliably watching that
 * validation. The `unit` project at least runs on every PR
 * (`.github/workflows/lint.yml`), which is why behavioural coverage belongs
 * here; the browser suite keeps its real-`window` prepend/dedup/cap coverage.
 *
 * 🔴 DON'T READ THAT AS "THIS BLOCKS A MERGE" — it does not. The `Unit tests`
 * job carries `continue-on-error: true`, so a red test annotates and merges.
 * The merge-blocking steps today are Typecheck, the "migrations are in the
 * schema package" check, ESLint/Prettier over ADDED files (all in
 * `.github/workflows/lint.yml`), and the `event-engine-common pin` job in
 * `.github/workflows/submodule-pin-guard.yml`. Running on every PR is the value
 * here; enforcement is not.
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

/**
 * The account every test below reads/writes as, unless it is specifically about
 * a second viewer. An arbitrary non-zero id — the point is only that it differs
 * from `OTHER_OWNER` and from `null` (the signed-out bucket).
 */
const OWNER = 7;
/** A DIFFERENT signed-in account, for the cross-account cases. */
const OTHER_OWNER = 8;

/** Write a RAW blob straight into the store, bypassing the write gate — this is
 *  the shape a hand-edited / legacy localStorage actually presents on read. */
function seedRaw(value: unknown) {
  storage.setItem(
    RECENTLY_OPENED_APPS_KEY,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
}

/**
 * Seed a well-formed v4 envelope owned by `ownerId`, bypassing the write gate.
 * Used by the entry-validation cases so they exercise `coerce` (the entry gate)
 * rather than tripping the envelope gate on the way in — a bare array is now
 * dropped wholesale, which would make every one of them pass vacuously.
 */
function seedOwned(apps: unknown, ownerId: number | null = OWNER) {
  seedRaw({ v: RECENTS_ENVELOPE_VERSION, ownerId, apps });
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
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
    expect(recordRecentlyOpenedApp({ id: 'a', blockId: 'a' }, OWNER)).toEqual([]);
    expect(() => clearRecentlyOpenedApps()).not.toThrow();
  });
});

describe('coerce — the untrusted-input validation layer', () => {
  it('a non-array blob reads as [] (object / string / number / null)', () => {
    for (const bad of [{ id: 'a' }, '"a string"', '42', 'null']) {
      seedRaw(bad);
      expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
    }
  });

  it('unparseable JSON reads as [] (fail-soft, never throws into the page)', () => {
    seedRaw('{ not valid json');
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  it('drops non-object array members without dropping their neighbours', () => {
    seedOwned([null, 'str', 7, { id: 'ok', blockId: 'ok' }, undefined]);
    expect(getRecentlyOpenedApps(OWNER).map((e) => e.id)).toEqual(['ok']);
  });

  it('requires a STRING id', () => {
    seedOwned([{ id: 1, blockId: 'x' }, { id: null, blockId: 'x' }, { blockId: 'x' }]);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  it('drops an entry with no navigable handle at all', () => {
    seedOwned([{ id: 'a' }, { id: 'b', blockId: '' }, { id: 'c', slug: '' }]);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  it('carries a LEGACY v1 {id, blockId} entry through untouched', () => {
    seedOwned([{ id: 'ab_9', blockId: 'legacy-app' }]);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([{ id: 'ab_9', blockId: 'legacy-app' }]);
  });

  it('an unknown `kind` value degrades to "no kind" rather than flowing into link logic', () => {
    seedOwned([{ id: 'a', blockId: 'a', kind: 'sideways' }]);
    expect(getRecentlyOpenedApps(OWNER)[0].kind).toBeUndefined();
  });

  it('wrong-typed enrichment fields are dropped, not carried (no crash, less enrichment)', () => {
    seedOwned([
      {
        id: 'a',
        blockId: 'a',
        hasPage: 'true',
        externalUrl: 42,
        name: { evil: true },
        iconUrl: ['x'],
      },
    ]);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([{ id: 'a', blockId: 'a' }]);
  });

  it('🔴 a stringy `hasPage` cannot survive into the rail as "this app has a page"', () => {
    // End-to-end version of the same guard: user-writable value → store → rail.
    seedOwned([{ id: 'a', blockId: 'gen', slug: 'gen', kind: 'onsite', hasPage: 'true' }]);
    const [entry] = getRecentlyOpenedApps(OWNER);
    expect(entry.hasPage).toBeUndefined();
    expect(resolveRecentApp(entry)!.hasPage).toBe(false);
  });
});

describe('🔴 the write gate and the read gate are the SAME gate', () => {
  // The bug this pins: `coerce` accepted `{id, blockId, kind:'offsite'}`, but
  // `resolveRecentApp` requires a `slug` for an off-site entry — so the value
  // persisted and then silently vanished on the next read.
  it('rejects an off-site entry with no slug on WRITE (blockId cannot stand in)', () => {
    const next = recordRecentlyOpenedApp(
      {
        id: 'x',
        blockId: 'not-a-listing-slug',
        kind: 'offsite',
      },
      OWNER
    );
    expect(next).toEqual([]);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  it('drops the same shape on READ', () => {
    seedOwned([{ id: 'x', blockId: 'not-a-listing-slug', kind: 'offsite' }]);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
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
      const accepted = recordRecentlyOpenedApp(candidate, OWNER);
      if (accepted.length === 0) continue; // rejected on write — fine
      expect(
        resolveRecentApp(accepted[0]),
        `accepted but unresolvable: ${candidate.id}`
      ).not.toBeNull();
    }
  });

  it('an off-site entry WITH a slug round-trips (write → read → resolve)', () => {
    recordRecentlyOpenedApp(
      {
        id: 'lst_1',
        slug: 'ext-app',
        kind: 'offsite',
        externalUrl: 'https://ext.example/app',
      },
      OWNER
    );
    const [entry] = getRecentlyOpenedApps(OWNER);
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
    recordRecentlyOpenedApp(onsite(1), OWNER);
    for (let i = 0; i < MAX_RECENTS + 4; i++) recordRecentlyOpenedApp(offsite(i), OWNER);

    const list = getRecentlyOpenedApps(OWNER);
    const onsiteEntries = list.filter((e) => e.kind !== 'offsite' && !!e.blockId);
    expect(onsiteEntries.map((e) => e.id)).toEqual(['on-1']);
  });

  it('and symmetrically: on-site traffic does not evict off-site entries', () => {
    recordRecentlyOpenedApp(offsite(1), OWNER);
    for (let i = 0; i < MAX_RECENTS + 4; i++) recordRecentlyOpenedApp(onsite(i), OWNER);
    expect(
      getRecentlyOpenedApps(OWNER)
        .filter((e) => e.kind === 'offsite')
        .map((e) => e.id)
    ).toEqual(['off-1']);
  });

  it('each kind is still capped at MAX_RECENTS, oldest-first eviction', () => {
    for (let i = 0; i < MAX_RECENTS + 3; i++) recordRecentlyOpenedApp(onsite(i), OWNER);
    const ids = getRecentlyOpenedApps(OWNER).map((e) => e.id);
    expect(ids).toHaveLength(MAX_RECENTS);
    expect(ids[0]).toBe(`on-${MAX_RECENTS + 2}`); // newest first
    expect(ids).not.toContain('on-0');
  });

  it('the whole list is bounded by MAX_RECENTS_TOTAL', () => {
    for (let i = 0; i < MAX_RECENTS + 5; i++) {
      recordRecentlyOpenedApp(onsite(i), OWNER);
      recordRecentlyOpenedApp(offsite(i), OWNER);
    }
    expect(getRecentlyOpenedApps(OWNER).length).toBe(MAX_RECENTS_TOTAL);
    expect(MAX_RECENTS_TOTAL).toBe(MAX_RECENTS * 2);
  });

  it('a legacy entry with NO kind counts against the ON-SITE budget (it is on-site by construction)', () => {
    seedOwned(
      Array.from({ length: MAX_RECENTS + 3 }, (_, i) => ({ id: `l-${i}`, blockId: `l-${i}` }))
    );
    expect(getRecentlyOpenedApps(OWNER)).toHaveLength(MAX_RECENTS);
  });

  it('the READ caps too, so a blob written by an older (flat-cap) build is still bounded', () => {
    seedOwned([
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
    const list = getRecentlyOpenedApps(OWNER);
    expect(list.filter((e) => e.kind === 'onsite')).toHaveLength(MAX_RECENTS);
    expect(list.filter((e) => e.kind === 'offsite')).toHaveLength(MAX_RECENTS);
  });
});

describe('ordering + dedupe + fail-soft write', () => {
  const app = (id: string): RecentApp => ({ id, blockId: `block-${id}` });

  it('prepends newest-first', () => {
    recordRecentlyOpenedApp(app('a'), OWNER);
    recordRecentlyOpenedApp(app('b'), OWNER);
    expect(getRecentlyOpenedApps(OWNER).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('re-recording moves to the front without duplicating', () => {
    recordRecentlyOpenedApp(app('a'), OWNER);
    recordRecentlyOpenedApp(app('b'), OWNER);
    recordRecentlyOpenedApp(app('a'), OWNER);
    expect(getRecentlyOpenedApps(OWNER).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('a quota / private-mode write throw is swallowed and still returns the in-memory list', () => {
    storage.throwOnSet = true;
    expect(recordRecentlyOpenedApp(app('a'), OWNER).map((e) => e.id)).toEqual(['a']);
    // …but nothing was persisted.
    storage.throwOnSet = false;
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  it('clear empties the store', () => {
    recordRecentlyOpenedApp(app('a'), OWNER);
    clearRecentlyOpenedApps();
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });
});

/**
 * 🔴 ACCOUNT SCOPING (#4048) — the defect this envelope exists for.
 *
 * OBSERVED, not hypothetical: a browser profile used first by a moderator
 * session and later signed in as a lower-privileged cohort account rendered a
 * "Recently opened" rail of six on-site apps that account cannot see. The rail
 * fetches nothing (the entries carry their own name/icon/slug), so nothing
 * reconciled them away, and every detail page behind them 404s for that viewer.
 * localStorage is per BROWSER PROFILE; identity is per ACCOUNT; nothing cleared
 * it on the switch.
 */
describe('🔴 recents are scoped to the account that recorded them', () => {
  const app = (id: string): RecentApp => ({ id, blockId: `block-${id}` });

  it('a viewer reads back what THEY recorded (positive control — the rest is not vacuous)', () => {
    recordRecentlyOpenedApp(app('mine'), OWNER);
    expect(getRecentlyOpenedApps(OWNER).map((e) => e.id)).toEqual(['mine']);
  });

  it('🔴 a DIFFERENT signed-in account reads an EMPTY rail', () => {
    recordRecentlyOpenedApp(app('mod-only'), OWNER);
    expect(getRecentlyOpenedApps(OTHER_OWNER)).toEqual([]);
  });

  it('🔴 a SIGNED-OUT viewer cannot read a signed-in account’s recents', () => {
    recordRecentlyOpenedApp(app('mod-only'), OWNER);
    expect(getRecentlyOpenedApps(null)).toEqual([]);
  });

  it('🔴 and the reverse: a signed-in viewer cannot read the ANONYMOUS bucket', () => {
    // `ownerId: null` is a bucket, not a wildcard. A guard written as
    // "no owner recorded → anyone may read it" passes the test above and fails
    // this one.
    recordRecentlyOpenedApp(app('anon-app'), null);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  it('the anonymous viewer reads back their OWN bucket (null is a real owner)', () => {
    recordRecentlyOpenedApp(app('anon-app'), null);
    expect(getRecentlyOpenedApps(null).map((e) => e.id)).toEqual(['anon-app']);
  });

  it('owner id 0 is a real account, not "signed out" (falsy-check guard)', () => {
    // `currentUser?.id ?? null` yields the number 0 for a hypothetical user 0; a
    // guard written with `!ownerId` would merge that account with the anonymous
    // bucket. Only `=== null` / `typeof === number` separates them.
    recordRecentlyOpenedApp(app('zero'), 0);
    expect(getRecentlyOpenedApps(0).map((e) => e.id)).toEqual(['zero']);
    expect(getRecentlyOpenedApps(null)).toEqual([]);
  });

  it('a read by a foreign owner does not DESTROY the owner’s blob (read ≠ write)', () => {
    recordRecentlyOpenedApp(app('mine'), OWNER);
    expect(getRecentlyOpenedApps(OTHER_OWNER)).toEqual([]);
    expect(getRecentlyOpenedApps(OWNER).map((e) => e.id)).toEqual(['mine']);
  });

  it('a write by a second account starts a FRESH list — it never inherits entries', () => {
    recordRecentlyOpenedApp(app('mine'), OWNER);
    const next = recordRecentlyOpenedApp(app('theirs'), OTHER_OWNER);
    expect(next.map((e) => e.id)).toEqual(['theirs']);
    expect(getRecentlyOpenedApps(OTHER_OWNER).map((e) => e.id)).toEqual(['theirs']);
    // …and the first account's blob is gone: one bucket is persisted at a time.
    // Documented tradeoff, not an oversight (see the module header).
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  it('the persisted blob is an owner-stamped envelope (the on-disk contract)', () => {
    recordRecentlyOpenedApp(app('mine'), OWNER);
    const raw = JSON.parse(storage.getItem(RECENTLY_OPENED_APPS_KEY) as string);
    expect(raw.v).toBe(RECENTS_ENVELOPE_VERSION);
    expect(raw.ownerId).toBe(OWNER);
    expect(raw.apps.map((a: RecentApp) => a.id)).toEqual(['mine']);
  });

  it('an anonymous write stamps ownerId: null, not a missing key', () => {
    recordRecentlyOpenedApp(app('anon-app'), null);
    const raw = JSON.parse(storage.getItem(RECENTLY_OPENED_APPS_KEY) as string);
    expect('ownerId' in raw).toBe(true);
    expect(raw.ownerId).toBeNull();
  });
});

/**
 * 🔴 THE ONE-TIME RESET, MADE EXPLICIT.
 *
 * A pre-v4 blob is a BARE `RecentApp[]` with no owner recorded. That owner is
 * unknowable — the browser holds no evidence of who wrote it — so it is DROPPED
 * rather than attributed to whoever reads it next. Attributing it is precisely
 * the bug. The cost is one rail reset per existing viewer (it repopulates on the
 * next app open, capped at MAX_RECENTS per kind, pure personalisation); the cost
 * of the alternative is showing one account's history to another.
 */
describe('🔴 a legacy (pre-owner) blob is dropped, never attributed', () => {
  const legacy = [
    { id: 'ab_1', blockId: 'moderator-only-app', name: 'Moderator Only App' },
    { id: 'ab_2', blockId: 'another-app', name: 'Another App' },
  ];

  it('a signed-in viewer inherits NOTHING from an un-owned blob', () => {
    seedRaw(legacy);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  it('nor does a signed-out one (there is no owner it could belong to)', () => {
    seedRaw(legacy);
    expect(getRecentlyOpenedApps(null)).toEqual([]);
  });

  it('the very next recorded open repopulates the rail (the reset is one-time)', () => {
    seedRaw(legacy);
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
    recordRecentlyOpenedApp({ id: 'fresh', blockId: 'fresh' }, OWNER);
    expect(getRecentlyOpenedApps(OWNER).map((e) => e.id)).toEqual(['fresh']);
  });

  it('an UNRECOGNISED envelope version is dropped too (rollback after a newer build)', () => {
    seedRaw({ v: RECENTS_ENVELOPE_VERSION + 1, ownerId: OWNER, apps: legacy });
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
    seedRaw({ ownerId: OWNER, apps: legacy }); // no version at all
    expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
  });

  it('an envelope whose ownerId is not a number-or-null is unownable → dropped', () => {
    for (const owner of ['7', undefined, {}, [], true]) {
      seedRaw({ v: RECENTS_ENVELOPE_VERSION, ownerId: owner, apps: legacy });
      expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
      expect(getRecentlyOpenedApps(null)).toEqual([]);
    }
  });

  it('a recognised envelope with a corrupt `apps` field degrades to [] (fail-soft, no throw)', () => {
    for (const apps of ['nope', 42, null, { id: 'a' }]) {
      seedRaw({ v: RECENTS_ENVELOPE_VERSION, ownerId: OWNER, apps });
      expect(() => getRecentlyOpenedApps(OWNER)).not.toThrow();
      expect(getRecentlyOpenedApps(OWNER)).toEqual([]);
    }
  });

  it('clear() removes a FOREIGN blob too (owner-agnostic by design)', () => {
    recordRecentlyOpenedApp({ id: 'theirs', blockId: 'theirs' }, OTHER_OWNER);
    clearRecentlyOpenedApps();
    expect(storage.getItem(RECENTLY_OPENED_APPS_KEY)).toBeNull();
  });
});
