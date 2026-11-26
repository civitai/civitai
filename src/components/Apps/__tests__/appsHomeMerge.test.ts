import { describe, expect, it } from 'vitest';
import { homeEmptyKind, mergeHomeApps } from '~/components/Apps/appsHomeMerge';
import { toRecentAppFromListing } from '~/components/Apps/recentAppsRail';
import {
  parseRecentsForOwner,
  RECENTS_ENVELOPE_VERSION,
  type RecentApp,
} from '~/components/Apps/recentlyOpenedAppsStore';
import type { MyAppRow } from '~/server/services/blocks/my-apps.logic';

/**
 * The `/apps` grid = server apps ∪ this account's local recents. Recents are fed through
 * the store's REAL pure reader (`parseRecentsForOwner`) where owner isolation or corruption
 * is the point, and through the store's REAL writer shape (`toRecentAppFromListing`) where
 * the join key is — so the keys under test are the ones production writes, not hand-typed
 * look-alikes.
 */

const row = (
  over: Partial<MyAppRow> & Pick<MyAppRow, 'listingId' | 'slug' | 'name'>
): MyAppRow => ({
  category: null,
  iconUrl: `https://img.invalid/${over.slug}.png`,
  coverUrl: null,
  kind: 'page',
  launchHref: `/apps/run/${over.slug}`,
  external: false,
  lastUsedAt: new Date('2026-10-01T00:00:00.000Z'),
  ...over,
});

const FORGE = row({ listingId: 'apl_forge', slug: 'pixel-forge', name: 'Pixel Forge' });
const TAGGER = row({ listingId: 'apl_tagger', slug: 'tag-wizard', name: 'Tag Wizard' });
const LAB = row({
  listingId: 'apl_lab',
  slug: 'prompt-lab',
  name: 'Prompt Lab',
  kind: 'offsite',
  launchHref: 'https://promptlab.example.org/app',
  external: true,
});

/** What the store card writes for an on-site listing with a block — the real key shape. */
const recentOnsite = (slug: string, appBlockId: string, name: string): RecentApp =>
  toRecentAppFromListing({
    id: `apl_unused_${slug}`,
    slug,
    name,
    iconUrl: null,
    kindData: { kind: 'onsite', appBlockId, hasPage: true, liveUrl: 'https://x.invalid' },
  });
/** What the store card writes for an off-site listing — id is the LISTING id. */
const recentOffsite = (listingId: string, slug: string, name: string, url: string): RecentApp =>
  toRecentAppFromListing({
    id: listingId,
    slug,
    name,
    iconUrl: null,
    kindData: { kind: 'offsite', externalUrl: url },
  });

const blob = (ownerId: number | null, apps: unknown) =>
  JSON.stringify({ v: RECENTS_ENVELOPE_VERSION, ownerId, apps });

describe('mergeHomeApps', () => {
  it('🔴 dedupes a recents entry against the server row it names — ONE tile, server fields win', () => {
    // The on-site recent carries the AppBlock id as its `id` (never the listing id), so the
    // join has to be the slug. A merge keyed on id alone would show Pixel Forge twice.
    const tiles = mergeHomeApps({
      server: [FORGE, TAGGER],
      recents: [recentOnsite('pixel-forge', 'ab_forge', 'Stale Forge Name')],
      canOpenPage: true,
    });
    expect(tiles.map((t) => [t.key, t.source, t.name])).toEqual([
      ['listing:apl_forge', 'both', 'Pixel Forge'],
      ['listing:apl_tagger', 'server', 'Tag Wizard'],
    ]);
  });

  it('dedupes an OFF-SITE recent by its listing id even if its slug drifted', () => {
    const tiles = mergeHomeApps({
      server: [LAB],
      recents: [
        recentOffsite(
          'apl_lab',
          'prompt-lab-old',
          'Prompt Lab',
          'https://promptlab.example.org/app'
        ),
      ],
      canOpenPage: true,
    });
    expect(tiles.map((t) => t.key)).toEqual(['listing:apl_lab']);
  });

  it('🔴 recents come FIRST, in stored order; then the remaining server rows in server order', () => {
    const tiles = mergeHomeApps({
      server: [FORGE, TAGGER, LAB], // the server's own order (lastUsedAt desc)
      recents: [
        recentOffsite('apl_lab', 'prompt-lab', 'Prompt Lab', 'https://promptlab.example.org/app'),
        recentOnsite('tag-wizard', 'ab_tagger', 'Tag Wizard'),
      ],
      canOpenPage: true,
    });
    expect(tiles.map((t) => t.slug)).toEqual(['prompt-lab', 'tag-wizard', 'pixel-forge']);
  });

  it('🔴 a recents-only entry renders from its stored fields, with NO stored icon', () => {
    const tiles = mergeHomeApps({
      server: [],
      recents: [
        recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch'),
        recentOffsite('apl_ext', 'ext-notes', 'Ext Notes', 'https://notes.example.org/'),
      ],
      canOpenPage: true,
    });
    expect(tiles).toEqual([
      expect.objectContaining({
        key: 'recent:neon-sketch',
        name: 'Neon Sketch',
        // The home stamps its launch origin on an in-site run link (`?from=home`)…
        launchHref: '/apps/run/neon-sketch?from=home',
        external: false,
        iconUrl: null,
        iconFromServer: false,
        source: 'recent',
        listingId: null,
      }),
      expect.objectContaining({
        key: 'recent:ext-notes',
        name: 'Ext Notes',
        // …and never on an off-site URL.
        launchHref: 'https://notes.example.org/',
        external: true,
        iconFromServer: false,
      }),
    ]);
  });

  it('a recents-only on-site entry launches its store page when the viewer cannot open pages', () => {
    const [tile] = mergeHomeApps({
      server: [],
      recents: [recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch')],
      canOpenPage: false,
    });
    expect(tile.launchHref).toBe('/apps/store-preview/neon-sketch');
  });

  it("a recents-only entry's stored name is sanitized (publisher text via localStorage)", () => {
    const [tile] = mergeHomeApps({
      server: [],
      recents: [{ id: 'ab_x', slug: 'x-app', blockId: 'x-app', kind: 'onsite', name: '‮evil' }],
      canOpenPage: true,
    });
    expect(tile.name).not.toContain('‮');
  });

  it('the same slug twice in recents yields one tile', () => {
    const r = recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch');
    expect(mergeHomeApps({ server: [], recents: [r, r], canOpenPage: true })).toHaveLength(1);
  });

  it('both sources empty → empty grid (the empty state)', () => {
    expect(mergeHomeApps({ server: [], recents: [], canOpenPage: true })).toEqual([]);
  });
});

describe('recents for the home are read per ACCOUNT, and a bad store reads as empty', () => {
  const OWN = 41;
  const OTHER = 73;
  const stored = [recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch')];

  it('🔴 another account’s recents never appear', () => {
    // Positive control first: the same blob DOES produce a tile for its own owner.
    expect(
      mergeHomeApps({
        server: [],
        recents: parseRecentsForOwner(blob(OWN, stored), OWN),
        canOpenPage: true,
      })
    ).toHaveLength(1);
    expect(
      mergeHomeApps({
        server: [],
        recents: parseRecentsForOwner(blob(OTHER, stored), OWN),
        canOpenPage: true,
      })
    ).toEqual([]);
    // …and the signed-out bucket is its own bucket, not a wildcard.
    expect(parseRecentsForOwner(blob(null, stored), OWN)).toEqual([]);
  });

  it.each([
    ['no store at all', null],
    ['not JSON', '{oops'],
    ['an unknown envelope version', JSON.stringify({ v: 1, ownerId: OWN, apps: stored })],
    [
      'apps is not an array',
      JSON.stringify({ v: RECENTS_ENVELOPE_VERSION, ownerId: OWN, apps: 'x' }),
    ],
    ['entries with no usable key', blob(OWN, [{ id: 7 }, { name: 'no id' }, null])],
  ])('a corrupt store (%s) reads as empty and the grid falls back to the server', (_l, raw) => {
    const recents = parseRecentsForOwner(raw, OWN);
    expect(recents).toEqual([]);
    expect(
      mergeHomeApps({ server: [FORGE], recents, canOpenPage: true }).map((t) => t.key)
    ).toEqual(['listing:apl_forge']);
  });
});

// ── "Remove from My apps" ────────────────────────────────────────────────────────
// The re-appear rule: shown ⇔ lastUsed > hiddenAt, where lastUsed is the LATER of the server
// row's `lastUsedAt` and this browser's recents `openedAt`. Every instant below is distinct
// from every other, so no assertion can pass by two fixtures coinciding.
const T_SERVER_OLD = new Date('2026-10-03T04:05:06.000Z'); // server use, BEFORE the hide
const T_HIDE = '2026-10-10T11:22:33.000Z';
const T_SERVER_NEW = new Date('2026-10-14T07:08:09.000Z'); // server use, AFTER the hide
const T_OPEN_OLD = Date.parse('2026-10-06T16:17:18.000Z'); // recents open, BEFORE the hide
const T_OPEN_NEW = Date.parse('2026-10-12T19:20:21.000Z'); // recents open, AFTER the hide

const withOpenedAt = (r: RecentApp, openedAt: number): RecentApp => ({ ...r, openedAt });

describe('mergeHomeApps — hidden apps (the single re-appear predicate)', () => {
  const forgeOld = { ...FORGE, lastUsedAt: T_SERVER_OLD };
  const forgeNew = { ...FORGE, lastUsedAt: T_SERVER_NEW };

  it('🔴 a hidden server app with no later use is excluded; its neighbours stay', () => {
    const tiles = mergeHomeApps({
      server: [forgeOld, TAGGER],
      recents: [],
      canOpenPage: true,
      hidden: { 'pixel-forge': T_HIDE },
    });
    expect(tiles.map((t) => t.slug)).toEqual(['tag-wizard']);
  });

  it('control: with no hide the same row is shown', () => {
    expect(
      mergeHomeApps({ server: [forgeOld], recents: [], canOpenPage: true }).map((t) => t.slug)
    ).toEqual(['pixel-forge']);
  });

  it('🔴 shown again when the SERVER lastUsedAt is after the hide', () => {
    const tiles = mergeHomeApps({
      server: [forgeNew],
      recents: [],
      canOpenPage: true,
      hidden: { 'pixel-forge': T_HIDE },
    });
    expect(tiles.map((t) => t.slug)).toEqual(['pixel-forge']);
  });

  it('🔴 shown again when ONLY the client recents openedAt is after the hide (server row older)', () => {
    const tiles = mergeHomeApps({
      server: [forgeOld],
      recents: [withOpenedAt(recentOnsite('pixel-forge', 'ab_forge', 'Pixel Forge'), T_OPEN_NEW)],
      canOpenPage: true,
      hidden: { 'pixel-forge': T_HIDE },
    });
    expect(tiles.map((t) => [t.slug, t.source])).toEqual([['pixel-forge', 'both']]);
  });

  it('🔴 a recents-ONLY app (no server row) comes back on an open after the hide', () => {
    const tiles = mergeHomeApps({
      server: [],
      recents: [withOpenedAt(recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch'), T_OPEN_NEW)],
      canOpenPage: true,
      hidden: { 'neon-sketch': T_HIDE },
    });
    expect(tiles.map((t) => [t.slug, t.source])).toEqual([['neon-sketch', 'recent']]);
  });

  it('🔴 still hidden when BOTH the server use and the recents open are before the hide', () => {
    const tiles = mergeHomeApps({
      server: [forgeOld, TAGGER],
      recents: [
        withOpenedAt(recentOnsite('pixel-forge', 'ab_forge', 'Pixel Forge'), T_OPEN_OLD),
        withOpenedAt(recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch'), T_OPEN_OLD),
      ],
      canOpenPage: true,
      hidden: { 'pixel-forge': T_HIDE, 'neon-sketch': T_HIDE },
    });
    // Neither the matched row (recents claimed it, so the server pass must NOT re-add it)
    // nor the recents-only entry renders.
    expect(tiles.map((t) => t.slug)).toEqual(['tag-wizard']);
  });

  it('a recents entry with NO openedAt (written before the field) counts as no use', () => {
    const tiles = mergeHomeApps({
      server: [],
      recents: [recentOnsite('neon-sketch', 'ab_neon', 'Neon Sketch')],
      canOpenPage: true,
      hidden: { 'neon-sketch': T_HIDE },
    });
    expect(tiles).toEqual([]);
  });

  it('🔴 the boundary: a use at EXACTLY the hide time keeps it hidden; 1 ms later shows it', () => {
    const at = (ms: number) =>
      mergeHomeApps({
        server: [{ ...FORGE, lastUsedAt: new Date(ms) }],
        recents: [],
        canOpenPage: true,
        hidden: { 'pixel-forge': T_HIDE },
      }).map((t) => t.slug);
    expect(at(Date.parse(T_HIDE))).toEqual([]);
    expect(at(Date.parse(T_HIDE) + 1)).toEqual(['pixel-forge']);
  });

  it.each([
    ['not a date', 'yesterday-ish'],
    ['a number', 1760095353000],
    ['null', null],
    ['an object', { at: T_HIDE }],
    ['an empty string', ''],
  ])('a garbage hiddenAt (%s) is ignored — the app shows', (_label, garbage) => {
    const tiles = mergeHomeApps({
      server: [forgeOld],
      recents: [],
      canOpenPage: true,
      hidden: { 'pixel-forge': garbage },
    });
    expect(tiles.map((t) => t.slug)).toEqual(['pixel-forge']);
  });
});

describe('mergeHomeApps — a row the server dropped as hidden still claims its recents entry', () => {
  // An OFF-SITE recent stored under an OLDER slug than its listing's
  // (`prompt-lab-old` vs `prompt-lab`), the hide written under the ROW's slug, and the row no
  // longer served because the server dropped it. Every id/slug below is pairwise distinct.
  const drifted = (openedAt?: number) => {
    const r = recentOffsite(
      'apl_lab',
      'prompt-lab-old',
      'Prompt Lab',
      'https://promptlab.example.org/app'
    );
    return openedAt == null ? r : withOpenedAt(r, openedAt);
  };
  const DROPPED = { apl_lab: 'prompt-lab' };

  it('🔴 opened BEFORE the hide → not shown (judged under the row slug, not its stale one)', () => {
    const tiles = mergeHomeApps({
      server: [TAGGER],
      recents: [drifted(T_OPEN_OLD)],
      canOpenPage: true,
      hidden: { 'prompt-lab': T_HIDE },
      removedSlugsByListingId: DROPPED,
    });
    expect(tiles.map((t) => t.slug)).toEqual(['tag-wizard']);
  });

  it('🔴 an entry with no openedAt is no use → not shown', () => {
    const tiles = mergeHomeApps({
      server: [],
      recents: [drifted()],
      canOpenPage: true,
      hidden: { 'prompt-lab': T_HIDE },
      removedSlugsByListingId: DROPPED,
    });
    expect(tiles).toEqual([]);
  });

  it('🔴 opened AFTER the hide → shown ONCE, under the row slug (so a re-remove writes the hide the server reads)', () => {
    const tiles = mergeHomeApps({
      server: [TAGGER],
      recents: [
        drifted(T_OPEN_NEW),
        // A second entry for the same listing, under its current slug: must not duplicate.
        withOpenedAt(
          recentOffsite('apl_lab', 'prompt-lab', 'Prompt Lab', 'https://promptlab.example.org/app'),
          T_OPEN_OLD
        ),
      ],
      canOpenPage: true,
      hidden: { 'prompt-lab': T_HIDE },
      removedSlugsByListingId: DROPPED,
    });
    expect(tiles.map((t) => [t.key, t.slug, t.source, t.launchHref])).toEqual([
      ['recent:prompt-lab', 'prompt-lab', 'recent', 'https://promptlab.example.org/app'],
      ['listing:apl_tagger', 'tag-wizard', 'server', '/apps/run/tag-wizard?from=home'],
    ]);
  });

  it('an entry whose id is NOT in the map is judged under its own slug, as before', () => {
    const args = {
      server: [] as MyAppRow[],
      recents: [drifted(T_OPEN_OLD)],
      canOpenPage: true,
      hidden: { 'prompt-lab': T_HIDE },
      removedSlugsByListingId: { apl_other: 'prompt-lab' },
    };
    // No hide names `prompt-lab-old`, so it shows — and identically with no map at all.
    const tiles = mergeHomeApps(args);
    expect(tiles.map((t) => [t.key, t.slug, t.source])).toEqual([
      ['recent:prompt-lab-old', 'prompt-lab-old', 'recent'],
    ]);
    expect(mergeHomeApps({ ...args, removedSlugsByListingId: undefined })).toEqual(tiles);
    // And a hide under its OWN slug still hides it.
    expect(mergeHomeApps({ ...args, hidden: { 'prompt-lab-old': T_HIDE } })).toEqual([]);
  });
});

describe('mergeHomeApps — launch origin', () => {
  it('🔴 an in-site run link carries ?from=home, preserving an existing query', () => {
    const tiles = mergeHomeApps({
      server: [
        FORGE,
        { ...TAGGER, launchHref: '/apps/run/tag-wizard?sl=asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A' },
      ],
      recents: [],
      canOpenPage: true,
    });
    expect(tiles.map((t) => t.launchHref)).toEqual([
      '/apps/run/pixel-forge?from=home',
      '/apps/run/tag-wizard?sl=asl_01J9ZK3Q4R5S6T7V8W9X0Y1Z2A&from=home',
    ]);
  });

  it('an off-site URL and a store page are left alone', () => {
    const tiles = mergeHomeApps({
      server: [LAB, { ...FORGE, launchHref: '/apps/store-preview/pixel-forge' }],
      recents: [],
      canOpenPage: true,
    });
    expect(tiles.map((t) => t.launchHref)).toEqual([
      'https://promptlab.example.org/app',
      '/apps/store-preview/pixel-forge',
    ]);
  });
});

describe('homeEmptyKind — why an empty home is empty', () => {
  const forgeOld = { ...FORGE, lastUsedAt: T_SERVER_OLD };

  it('🔴 every app removed → all-removed (not "No apps yet")', () => {
    const args = {
      server: [forgeOld],
      recents: [],
      canOpenPage: true,
      hidden: { 'pixel-forge': T_HIDE },
    };
    expect(mergeHomeApps(args)).toEqual([]); // precondition: the home IS empty
    expect(homeEmptyKind(args)).toBe('all-removed');
  });

  it('🔴 the server dropped every app (removedCount > 0, nothing served) → all-removed', () => {
    const args = { server: [], recents: [], canOpenPage: true, hidden: { 'pixel-forge': T_HIDE } };
    expect(homeEmptyKind({ ...args, removedCount: 3 })).toBe('all-removed');
    // Control: the same empty payload without the count is "no apps".
    expect(homeEmptyKind({ ...args, removedCount: 0 })).toBe('no-apps');
  });

  it('nothing at all → no-apps, with or without stale hides', () => {
    expect(homeEmptyKind({ server: [], recents: [], canOpenPage: true })).toBe('no-apps');
    expect(
      homeEmptyKind({ server: [], recents: [], canOpenPage: true, hidden: { gone: T_HIDE } })
    ).toBe('no-apps');
  });
});
