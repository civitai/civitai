import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE `/apps` CATALOG CACHE CANNOT SERVE ONE VIEWER'S PAGE TO ANOTHER.
 *
 * `listAvailableListings` now reads its keyset id page through `queryCache`
 * (`~/server/utils/cache-helpers`) with a 180s TTL and the `app-listing:catalog`
 * bust tag. Caching a page whose CONTENTS DEPEND ON THE VIEWER is the single way
 * this change can do harm, and it has two such axes:
 *
 *   · `scope` — `listingPublicVisibilityFilter`. `full` sees the whole approved
 *     catalog; `public-external` sees OFFSITE listings only. That is the
 *     public/onsite security boundary (civitai#3983 is the incident where it was
 *     defaulted open). A cache that collided the two would serve on-site apps to
 *     anonymous callers of `GET /api/v1/apps` — the same defect, arrived at from
 *     the cache instead of from a `??`.
 *
 *   · `redCapable` — `listingMatureFilter`. A non-red-capable host must not be
 *     shown `r`/`x` listings. A collision here serves mature cards onto a SFW
 *     domain.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS ASSERTS ON THE DERIVED KEY, NOT ON WORDS IN THE SQL
 * ─────────────────────────────────────────────────────────────────────────────
 * The sibling suite `app-listing.public-scope.test.ts` already guards the SQL
 * TEXT (`al.kind = 'offsite'` present / absent). That is a guard on WORDS, and it
 * says nothing about the cache: two statements can differ in text and still be
 * asked to share an entry if the key is assembled by hand from a hand-listed set
 * of axes.
 *
 * `queryCache` does not assemble the key by hand. It builds it as
 * `[key, version, hashifyObject(query)].join(':')` over the WHOLE `Prisma.Sql` —
 * text and bound params — so every axis interpolated into the statement is in the
 * key BY CONSTRUCTION. This file pins exactly that property: it captures the
 * `Prisma.Sql` the service hands `queryCache` for each viewer shape, derives the
 * key the way `cache-helpers` derives it (with the REAL `hashifyObject`), and
 * asserts the keys are distinct.
 *
 * Re-wording the SQL cannot satisfy this. Only actually making two viewer shapes
 * produce the same statement can — which is precisely the defect.
 *
 * ⚠️ `redCapable` is a SECOND viewer-varying axis, and the reason the derived-key
 * form matters: a hand-written key naming `scope` would look complete and still
 * miss it. Nothing here enumerates axes.
 */

/**
 * The capture. `queryCache(db, key, version)` is called once at MODULE level in the
 * service, so this factory records the cache name/version there and the per-call
 * `(sql, options)` on every invocation.
 *
 * It returns `[]`, which makes `listAvailableListings` short-circuit before the
 * hydration — this file is about the KEY, not the rows, so no DB fixture is needed.
 * DB deps come from the CANONICAL `dbMock` registered in `src/__tests__/setup.ts`.
 * A per-file mock of `~/server/db/client` is forbidden by
 * `no-direct-shared-module-mock` — and note that guard is TEXTUAL, so writing the
 * forbidden call as a code sample in this very comment trips it too.
 */
const { cacheCalls, cacheBinding } = vi.hoisted(() => ({
  cacheCalls: [] as { sql: unknown; options: { ttl?: number; tag?: unknown } | undefined }[],
  cacheBinding: [] as { key: string; version?: string }[],
}));

vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache: (_db: unknown, key: string, version?: string) => {
    cacheBinding.push({ key, version });
    return async (sql: unknown, options?: { ttl?: number; tag?: unknown }): Promise<unknown[]> => {
      cacheCalls.push({ sql, options });
      return [];
    };
  },
  // 🔴 BOTH EXPORTS. The service imports `bustCacheTag` too (it owns
  // `bustAppListingCatalogCache`), and a one-key factory makes the whole FILE fail to
  // import with `No "bustCacheTag" export is defined on the … mock`.
  bustCacheTag: vi.fn(async () => undefined),
}));

import { hashifyObject } from '~/utils/string-helpers';
import { listAvailableListings } from '../app-listing.service';
import { APP_LISTING_CATALOG_TAG } from '../app-listing-cache.constants';
import type { StoreVisibilityScope } from '~/server/services/app-blocks-flag';

const BASE_INPUT = { kind: 'all', sort: 'newest', limit: 20 } as const;

/** The most recent `(sql, options)` the service handed the cache. */
function lastCall() {
  const call = cacheCalls.at(-1);
  if (!call) throw new Error('listAvailableListings never called the query cache');
  return call;
}

/**
 * Derive the redis key EXACTLY as `queryCache` does — same `hashifyObject`, same
 * `[key, version, hash].join(':')`. Not a re-implementation of the hash: the real
 * `hashifyObject` is imported and called on the real `Prisma.Sql`.
 */
function deriveKey(sql: unknown): string {
  const binding = cacheBinding.at(-1);
  if (!binding) throw new Error('queryCache was never bound');
  return [binding.key, binding.version, hashifyObject(sql).toString()]
    .filter((p) => p != null && p !== '')
    .join(':');
}

/** Run the list path for one viewer shape and return the cache key it would use. */
async function keyFor(opts: { scope?: StoreVisibilityScope; redCapable?: boolean }) {
  await listAvailableListings({ ...BASE_INPUT }, opts);
  return deriveKey(lastCall().sql);
}

beforeEach(() => {
  cacheCalls.length = 0;
  vi.clearAllMocks();
});

describe('/apps catalog cache — the key separates viewers', () => {
  /**
   * 🔴 POSITIVE CONTROL, FIRST. Every assertion below is "these two keys DIFFER",
   * and that is also what you observe from a key derivation that is simply
   * unstable — a hash over something with a timestamp or an object identity in it
   * would make every pair differ and every guard below vacuously green.
   *
   * So prove the derivation is DETERMINISTIC for an unchanged viewer shape before
   * reading anything into a difference.
   */
  it('is stable: the same viewer shape twice derives the SAME key', async () => {
    const a = await keyFor({ scope: 'full', redCapable: false });
    const b = await keyFor({ scope: 'full', redCapable: false });
    expect(a).toBe(b);
    // …and it is a real key, not an empty string two ways.
    expect(a.startsWith('listAvailableAppListings:')).toBe(true);
  });

  it('🔴 scope `full` and `public-external` can never share a cache entry', async () => {
    const full = await keyFor({ scope: 'full', redCapable: false });
    const publicExternal = await keyFor({ scope: 'public-external', redCapable: false });
    expect(
      publicExternal,
      'the public-external and full store scopes derive the SAME cache key, so an ' +
        'anonymous /api/v1/apps caller can be served a page built for the full ' +
        'catalog — on-site apps included. That is civitai#3983 re-opened through the ' +
        'cache. `listingPublicVisibilityFilter` must emit DIFFERENT SQL per scope.'
    ).not.toBe(full);
  });

  it('🔴 `none` (the fail-closed scope) cannot share an entry with either', async () => {
    const none = await keyFor({ scope: undefined, redCapable: false });
    const full = await keyFor({ scope: 'full', redCapable: false });
    const publicExternal = await keyFor({ scope: 'public-external', redCapable: false });
    expect(none).not.toBe(full);
    expect(none).not.toBe(publicExternal);
  });

  it('🔴 redCapable true and false can never share a cache entry', async () => {
    const red = await keyFor({ scope: 'full', redCapable: true });
    const sfw = await keyFor({ scope: 'full', redCapable: false });
    expect(
      sfw,
      'a red-capable and a SFW-only host derive the SAME cache key, so mature (r/x) ' +
        'listings can be served onto a SFW domain from a page built for a red host. ' +
        '`listingMatureFilter` must emit DIFFERENT SQL per capability.'
    ).not.toBe(red);
  });

  /**
   * The two axes TOGETHER. Each pair above is a 1-D claim; a key that folded the two
   * axes into one bit would satisfy both and still collide `{full, sfw}` with
   * `{public-external, red}`. Six pairs, all distinct.
   */
  it('🔴 all four (scope × redCapable) viewer shapes are pairwise distinct', async () => {
    const shapes: { scope: StoreVisibilityScope; redCapable: boolean }[] = [
      { scope: 'full', redCapable: true },
      { scope: 'full', redCapable: false },
      { scope: 'public-external', redCapable: true },
      { scope: 'public-external', redCapable: false },
    ];
    const keys: string[] = [];
    for (const shape of shapes) keys.push(await keyFor(shape));
    expect(new Set(keys).size, `two viewer shapes collided: ${JSON.stringify(keys)}`).toBe(
      shapes.length
    );
  });

  /**
   * The NON-viewer axes, for completeness — these are ordinary correctness rather
   * than a disclosure boundary, but they are in the key by the same construction and
   * a regression on them serves the wrong page just as surely.
   */
  it('kind, category, sort, limit and cursor each change the key', async () => {
    const base = await keyFor({ scope: 'full', redCapable: false });
    const variants: Record<string, Record<string, unknown>> = {
      kind: { kind: 'offsite' },
      category: { category: 'utility' },
      sort: { sort: 'name' },
      limit: { limit: 21 },
    };
    for (const [axis, over] of Object.entries(variants)) {
      await listAvailableListings({ ...BASE_INPUT, ...over } as never, {
        scope: 'full',
        redCapable: false,
      });
      expect(deriveKey(lastCall().sql), `the \`${axis}\` axis is not in the cache key`).not.toBe(
        base
      );
    }
  });

  it('the page is written with the catalog bust tag and the 180s TTL', async () => {
    await keyFor({ scope: 'full', redCapable: false });
    const { options } = lastCall();
    expect(options?.tag).toEqual([APP_LISTING_CATALOG_TAG]);
    expect(options?.ttl).toBe(180);
  });

  /**
   * 🔴 DRIFT-GUARD ON THE FORMULA THIS FILE REPRODUCES.
   *
   * `deriveKey` above mirrors `queryCache`'s key construction. If `cache-helpers`
   * ever stopped hashing the whole `Prisma.Sql` — hashing only `query.sql`, say, and
   * dropping the bound params — every assertion in this file would keep passing
   * while the property it claims to guard was gone. Pin the line.
   */
  it('cache-helpers still keys on a hash of the WHOLE Prisma.Sql', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/server/utils/cache-helpers.ts'),
      'utf8'
    );
    const normalized = src.replace(/\s+/g, ' ');
    expect(
      normalized,
      'queryCache no longer builds its key from `hashifyObject(query)` over the whole ' +
        'Prisma.Sql. This suite derives keys that way, so it is now measuring itself. ' +
        'Re-derive `deriveKey` against the new formula before trusting any result here.'
    ).toContain("[key, version, hashifyObject(query).toString()].filter(isDefined).join(':')");
  });
});
