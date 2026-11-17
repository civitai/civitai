import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE DEVELOPER READS REUSE THE STORE PREDICATE — THEY DO NOT RESTATE IT.
 *
 * Two reads answer "what has this developer published" on a listing page and a profile:
 *   - the "More by this developer" rail and the profile Apps tab, both
 *     `listAvailableListings({ userId })`;
 *   - the track-record line, `getDeveloperTrackRecord`.
 *
 * Both must count and list exactly what this viewer could find in the `/apps` store. That is
 * true only while each statement is built from `storeEligibilityWhere` with the developer as
 * one more term, so this file captures the `Prisma.Sql` each read hands the query cache and
 * asserts the predicate's own output is inside it. A hand-written WHERE (even a correct one on
 * the day it lands) fails here, because it would drift the next time the store predicate gains
 * a term. The rows each read admits are pinned separately, against a real Postgres, in
 * `app-listing-track-record.service.behavior.test.ts`.
 */

const { cacheCalls, cacheBinding } = vi.hoisted(() => ({
  cacheCalls: [] as { key: string; sql: unknown; options: unknown }[],
  cacheBinding: [] as { key: string; version?: string }[],
}));

vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache: (_db: unknown, key: string, version?: string) => {
    cacheBinding.push({ key, version });
    return async (sql: unknown, options?: unknown): Promise<unknown[]> => {
      cacheCalls.push({ key, sql, options });
      return [];
    };
  },
  bustCacheTag: vi.fn(async () => undefined),
}));

import { Prisma } from '@prisma/client';
import { APP_LISTING_CATALOG_TAG } from '../app-listing-cache.constants';
import { matureRatingsAllowed } from '../app-listing-store-gate';
import {
  listAvailableListings,
  listingLevelVisibilityFilter,
  storeEligibilityWhere,
  storeOwnerEligibleWhere,
} from '../app-listing.service';
import { getDeveloperTrackRecord } from '../app-listing-track-record.service';

const DEV = 4101;
const OTHER_DEV = 4202;

/** The store predicate, built the way the store grid builds it, narrowed to one developer. */
function expectedEligibility(opts: {
  userId: number;
  scope: 'full' | 'public-external';
  redCapable: boolean;
  level: number;
}) {
  return storeEligibilityWhere({
    levelFilter: listingLevelVisibilityFilter('public'),
    kind: null,
    category: null,
    mature: matureRatingsAllowed(opts.redCapable, opts.level),
    scope: opts.scope,
    userId: opts.userId,
  }) as Prisma.Sql;
}

/**
 * The DEVELOPER filter is the equality `al.user_id = <bound param>`. It is told apart from the
 * owner-eligibility EXISTS, which every store statement carries and which also names
 * `al.user_id` (as the correlated owner id, never compared to a parameter).
 */
const DEVELOPER_TERM = /al\.user_id = \?/g;
const developerTerms = (sql: Prisma.Sql) => (sql.sql.match(DEVELOPER_TERM) ?? []).length;
/** The banned/deleted-owner gate, as the store predicate spells it for the listing's owner. */
const OWNER_GATE = storeOwnerEligibleWhere(Prisma.sql`al.user_id`).sql;

function callsFor(prefix: string) {
  return cacheCalls.filter((c) => c.key.startsWith(prefix));
}

beforeEach(() => {
  cacheCalls.length = 0;
  cacheBinding.length = 0;
});

describe('getDeveloperTrackRecord — reuses storeEligibilityWhere', () => {
  it("🔴 the count statement contains the store predicate's own SQL, with the developer bound", async () => {
    await getDeveloperTrackRecord({
      userId: DEV,
      scope: 'full',
      floor: 'public',
      redCapable: false,
      viewerBrowsingLevel: 1,
    });
    const [call] = callsFor('appListingDeveloperTrackRecord:');
    expect(call, 'getDeveloperTrackRecord never read through the query cache').toBeDefined();
    const sql = call.sql as Prisma.Sql;
    const eligible = expectedEligibility({
      userId: DEV,
      scope: 'full',
      redCapable: false,
      level: 1,
    });
    expect(sql.sql).toContain(eligible.sql);
    expect(sql.values).toContain(DEV);
  });

  it('follows the viewer: a red-capable X viewer and the external-only scope get their own predicate', async () => {
    await getDeveloperTrackRecord({
      userId: DEV,
      scope: 'public-external',
      floor: 'public',
      redCapable: true,
      viewerBrowsingLevel: 15,
    });
    const [call] = callsFor('appListingDeveloperTrackRecord:');
    const eligible = expectedEligibility({
      userId: DEV,
      scope: 'public-external',
      redCapable: true,
      level: 15,
    });
    expect((call.sql as Prisma.Sql).sql).toContain(eligible.sql);
    expect((call.sql as Prisma.Sql).sql).toContain("al.kind = 'offsite'");
  });

  it('🔴 cached for 180s under the catalog bust tag, with every viewer axis a literal key segment', async () => {
    await getDeveloperTrackRecord({
      userId: DEV,
      scope: 'full',
      floor: 'public',
      redCapable: true,
      viewerBrowsingLevel: 7,
    });
    const [call] = callsFor('appListingDeveloperTrackRecord:');
    expect(call.key).toBe('appListingDeveloperTrackRecord:full:public:red:mr-');
    expect(call.options).toEqual({ ttl: 180, tag: [APP_LISTING_CATALOG_TAG] });
  });

  it('the developer id is NOT a literal key segment (the key is also a metric label)', async () => {
    const base = {
      scope: 'full',
      floor: 'public',
      redCapable: false,
      viewerBrowsingLevel: 1,
    } as const;
    await getDeveloperTrackRecord({ ...base, userId: DEV });
    await getDeveloperTrackRecord({ ...base, userId: OTHER_DEV });
    const [a, b] = callsFor('appListingDeveloperTrackRecord:');
    expect(a.key).toBe(b.key);
    expect(a.key).not.toContain(String(DEV));
    // …so it must be in the hashed statement instead, or two developers would share an entry.
    expect((a.sql as Prisma.Sql).values).toContain(DEV);
    expect((b.sql as Prisma.Sql).values).toContain(OTHER_DEV);
  });

  it('an empty statement result reads as zero apps, zero reviews', async () => {
    await expect(
      getDeveloperTrackRecord({
        userId: DEV,
        scope: 'full',
        floor: 'public',
        redCapable: false,
        viewerBrowsingLevel: 1,
      })
    ).resolves.toEqual({ appCount: 0, reviewCount: 0 });
  });
});

describe('listAvailableListings({ userId }) — the rail and the profile tab', () => {
  it("🔴 the store's id page carries the store predicate with the developer term", async () => {
    await listAvailableListings(
      { kind: 'all', sort: 'popular', limit: 4, userId: DEV },
      { scope: 'full', floor: 'public', redCapable: false, viewerBrowsingLevel: 1 }
    );
    const [call] = callsFor('listAvailableAppListings:');
    expect(call).toBeDefined();
    const eligible = expectedEligibility({
      userId: DEV,
      scope: 'full',
      redCapable: false,
      level: 1,
    });
    expect((call.sql as Prisma.Sql).sql).toContain(eligible.sql);
    expect((call.sql as Prisma.Sql).values).toContain(DEV);
  });

  it('without a developer the store grid statement has no developer filter (unchanged)', async () => {
    await listAvailableListings(
      { kind: 'all', sort: 'popular', limit: 4 },
      { scope: 'full', floor: 'public', redCapable: false, viewerBrowsingLevel: 1 }
    );
    const [call] = callsFor('listAvailableAppListings:');
    const sql = call.sql as Prisma.Sql;
    expect(developerTerms(sql)).toBe(0);
    // …while the owner gate is still there: the grid keeps hiding banned / deleted owners.
    expect(sql.sql).toContain(OWNER_GATE);
  });

  it('storeEligibilityWhere emits the developer term only when a developer is given, and the owner gate always', () => {
    const base = {
      levelFilter: listingLevelVisibilityFilter('public'),
      kind: null,
      category: null,
      mature: matureRatingsAllowed(false, 1),
      scope: 'full',
    } as const;
    const withDev = storeEligibilityWhere({ ...base, userId: DEV }) as Prisma.Sql;
    const without = storeEligibilityWhere(base) as Prisma.Sql;
    // The developer equality appears exactly once with a developer and never without one…
    expect(developerTerms(withDev)).toBe(1);
    expect(withDev.values).toContain(DEV);
    expect(developerTerms(without)).toBe(0);
    expect(without.values).not.toContain(DEV);
    // …and the owner-eligibility EXISTS is in both: the developer filter never replaces it.
    expect(withDev.sql).toContain(OWNER_GATE);
    expect(without.sql).toContain(OWNER_GATE);
    // The rest of the predicate is the same text either way: the developer narrows it, never
    // replaces a term.
    expect(withDev.sql.startsWith(without.sql.trimEnd())).toBe(true);
  });
});
