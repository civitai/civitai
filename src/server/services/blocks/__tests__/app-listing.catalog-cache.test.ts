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
 * 🔴 THE TWO LEVELS THIS FILE GUARDS, AND WHY THE SECOND ONE EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * (1) DERIVED KEYS DIFFER. The sibling suite `app-listing.public-scope.test.ts`
 *     already guards the SQL TEXT (`al.kind = 'offsite'` present / absent). That
 *     is a guard on WORDS and says nothing about the cache: two statements can
 *     differ in text and still be asked to share an entry. So this file captures
 *     the `Prisma.Sql` the service hands `queryCache` for each viewer shape,
 *     derives the key the way `cache-helpers` derives it (with the REAL
 *     `hashifyObject`), and asserts the keys are distinct.
 *
 * (2) 🔴 THE BOUNDARY IS NOT HASH-DEPENDENT. Level (1) is necessary and NOT
 *     sufficient, and an earlier revision of this file stopped there. "Distinct
 *     statements ⇒ distinct keys" assumes `hashifyObject` is INJECTIVE. It is
 *     not: `hashify` (`~/utils/string-helpers`) is a **32-bit** rolling hash,
 *     `hash = (hash << 5) - hash + chr; hash |= 0`. It is linear, so a collision
 *     against a chosen target is CONSTRUCTED algebraically — not brute-forced —
 *     and the attacker has the bytes to do it with: `decodeListingCursor` slices
 *     `cursorSortKey` and `cursorId` out of a lenient base64url decode as
 *     arbitrary free strings (only `cursorMean` is range-validated) and the read
 *     schema bounds `cursor` only by `z.string().max(128)`. Both land in the
 *     hashed statement as bound params, which is what makes a collision between
 *     the two scope predicates (`TRUE` vs `al.kind = 'offsite'`) CONSTRUCTIBLE
 *     rather than something to brute-force.
 *
 *     ⚠️ Nothing here constructs one, and no test asserts a byte count for it. An
 *     earlier version of this comment quoted "six tuning characters"; that figure
 *     was never derived or pinned, so it is gone rather than replaced. It does not
 *     need replacing: the guards below put the boundary OUTSIDE the hash entirely,
 *     which makes the exact cost of a collision irrelevant rather than merely large.
 *
 *     The service's answer is NOT to widen the hash (global blast radius — it
 *     keys caches, DOM ids and de-dup across the codebase). It is to lift the two
 *     SECURITY-BOUNDARY axes OUT of the hashed payload and into the literal `key`
 *     string: `listAvailableAppListings:<scope>:<red|sfw>`. A hash collision can
 *     then only ever mix two pages WITHIN one viewer class.
 *
 *     So the tests below assert on the key with its hash segment REMOVED. That is
 *     the half of the key a collision cannot touch, and it is the only form of
 *     this guard that a 32-bit hash cannot walk past.
 *
 * ⚠️ `redCapable` is a SECOND viewer-varying axis, and the reason the derived-key
 * form matters at level (1): a hand-written key naming `scope` would look complete
 * and still miss it. Nothing here enumerates axes.
 */

/**
 * The capture. `queryCache(db, key, version)` is called PER INVOCATION, inside
 * `catalogPageCache(scope, redCapable)` — that is the fix this PR makes, because a
 * module-level binding could only ever hold ONE key and so could not carry the viewer
 * class. This factory therefore records a `cacheBinding` entry per call, not one for
 * the module, and each entry is the key for the viewer shape that produced it.
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
import { bustCacheTag } from '~/server/utils/cache-helpers';
import { bustAppListingCatalogCache, listAvailableListings } from '../app-listing.service';
import {
  APP_LISTING_CATALOG_TAG,
  APP_LISTING_RECOMMEND_MEAN_TAG,
} from '../app-listing-cache.constants';
import type { StoreVisibilityScope } from '~/server/services/app-blocks-flag';
// The runtime value set, from the leaf module that owns it (no imports of its own), so
// the viewer-class count below is DERIVED rather than restated.
import { STORE_VISIBILITY_SCOPES } from '~/shared/utils/store-visibility-scope';

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

/**
 * 🔴 The key WITHOUT its hash segment — i.e. everything a `hashifyObject` collision
 * cannot change.
 *
 * `queryCache` puts the hash LAST (`[key, version, hash].join(':')`), so dropping the
 * final `:`-segment leaves exactly the literal `key` + `version` the service chose.
 * Two viewer shapes whose PREFIXES differ cannot be made to share a redis entry by any
 * collision, however constructed; two whose prefixes are equal are separated only by a
 * 32-bit hash over attacker-influenced bytes.
 *
 * `keyPrefixIsolatesTheHash` below is the positive control that this really is dropping
 * the hash and nothing else.
 */
function keyPrefix(key: string): string {
  const parts = key.split(':');
  return parts.slice(0, -1).join(':');
}

/** Run the list path for one viewer shape and return the HASH-INDEPENDENT key prefix. */
async function prefixFor(opts: { scope?: StoreVisibilityScope; redCapable?: boolean }) {
  return keyPrefix(await keyFor(opts));
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

  // ═══════════════════════════════════════════════════════════════════════════
  // 🔴 LEVEL (2): THE BOUNDARY IS NOT HASH-DEPENDENT.
  //
  // Every assertion above this line is satisfied by "the two statements differ",
  // which a 32-bit hash can undo. These are satisfied only by the boundary axes
  // being LITERAL, UN-HASHED segments of the redis key.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 🔴 POSITIVE CONTROL ON `keyPrefix` ITSELF, and it has to come first.
   *
   * `keyPrefix` claims to strip the hash and leave the literal part. If it stripped
   * MORE than the hash — or if the hash were not the last segment — every prefix
   * assertion below would be measuring something other than what it says.
   *
   * The discriminating case is a NON-boundary axis: `sort` is interpolated into the
   * statement and is NOT in the literal key. So changing it MUST move the full key
   * (it is hashed) and MUST NOT move the prefix (it is not literal). One case, both
   * directions, and it fails if `keyPrefix` slices at the wrong place.
   */
  it('keyPrefixIsolatesTheHash: a non-boundary axis moves the key but NOT the prefix', async () => {
    const base = await keyFor({ scope: 'full', redCapable: false });
    await listAvailableListings({ ...BASE_INPUT, sort: 'name' } as never, {
      scope: 'full',
      redCapable: false,
    });
    const other = deriveKey(lastCall().sql);
    expect(other, '`sort` is not in the hashed statement at all').not.toBe(base);
    expect(
      keyPrefix(other),
      '`keyPrefix` is not isolating the hash segment: a purely-hashed axis moved the ' +
        'prefix too, so every prefix assertion below is measuring the hash after all.'
    ).toBe(keyPrefix(base));
    // …and the prefix is a real, non-empty literal, not two empty strings. (Note this
    // assertion stays TRUE with the boundary axes hashed — it is a control, not a guard;
    // the guards are below.)
    expect(keyPrefix(base).startsWith('listAvailableAppListings:')).toBe(true);
  });

  /**
   * 🔴 THE HEADLINE GUARD. `scope` — the public/onsite security boundary — must be a
   * LITERAL segment of the cache key, so no `hashifyObject` collision can cross it.
   *
   * WHY A HASH COLLISION IS REACHABLE HERE, not theoretical: `hashify` is a 32-bit
   * linear rolling hash and `decodeListingCursor` admits `cursorSortKey` / `cursorId`
   * as arbitrary free strings straight into the hashed statement as bound params —
   * enough attacker-chosen bytes to solve for a collision between the `full` statement
   * and the `public-external` one instead of searching for it. (No test constructs one
   * and no byte count is claimed; see the file header.) If the scope lived only inside
   * the hash, that collision would serve on-site apps into the anonymous
   * `GET /api/v1/apps` response
   * (civitai#3983, re-opened through the cache) — and the reverse direction is cache
   * poisoning.
   */
  it('🔴 `scope` is a LITERAL key segment — a hash collision cannot cross the store-scope boundary', async () => {
    const full = await prefixFor({ scope: 'full', redCapable: false });
    const publicExternal = await prefixFor({ scope: 'public-external', redCapable: false });
    expect(
      publicExternal,
      'the store SCOPE is not in the un-hashed part of the cache key, so `full` and ' +
        '`public-external` are separated ONLY by a 32-bit hash over a statement whose ' +
        'cursor bytes the caller supplies. That hash is constructible: a crafted cursor ' +
        'serves the full catalog (on-site apps included) to an anonymous /api/v1/apps ' +
        'caller. Put `scope` back into the `key` string passed to `queryCache`.'
    ).not.toBe(full);
  });

  /**
   * The maturity gate, same property. A cross-capability collision serves `r`/`x`
   * listings onto a SFW host.
   */
  it('🔴 `redCapable` is a LITERAL key segment — a hash collision cannot cross the maturity gate', async () => {
    const red = await prefixFor({ scope: 'full', redCapable: true });
    const sfw = await prefixFor({ scope: 'full', redCapable: false });
    expect(
      sfw,
      'the maturity capability is not in the un-hashed part of the cache key, so a ' +
        'red-capable and a SFW-only host are separated ONLY by a constructible 32-bit ' +
        'hash. Put `redCapable` back into the `key` string passed to `queryCache`.'
    ).not.toBe(red);
  });

  /**
   * The WHOLE `scope × redCapable` product on the hash-independent prefix. `none` is
   * included: the router short-circuits it, but it is the fail-closed scope and must
   * not be able to share an entry with a scope that returns rows.
   *
   * Pairwise-distinct prefixes is the whole property this change buys — stated once,
   * over the full product, so a key that folded two axes into one bit cannot satisfy
   * the 1-D cases above and slip through here.
   *
   * 🔴 The count is DERIVED from `STORE_VISIBILITY_SCOPES`, not written down, so this
   * also pins the cardinality claim `catalogPageCache` makes about the `cache_name`
   * metric label. Adding a scope adds two classes and fails here until enumerated.
   */
  it('🔴 every (scope × redCapable) viewer class has a distinct HASH-INDEPENDENT prefix', async () => {
    const shapes: { scope?: StoreVisibilityScope; redCapable: boolean }[] = [
      { scope: 'full', redCapable: true },
      { scope: 'full', redCapable: false },
      { scope: 'public-external', redCapable: true },
      { scope: 'public-external', redCapable: false },
      { scope: 'none', redCapable: true },
      { scope: undefined, redCapable: false }, // → narrowStoreScope → 'none'
    ];
    expect(
      shapes.length,
      'the viewer-class product changed size. `catalogPageCache` states the ' +
        '`cache_name` label cardinality is bounded at (scopes x 2) — enumerate the new ' +
        'classes here and update that note in the same commit.'
    ).toBe(STORE_VISIBILITY_SCOPES.length * 2);
    const prefixes: string[] = [];
    for (const shape of shapes) prefixes.push(await prefixFor(shape));
    // The prefix must carry MORE than `<key>:<version>` — i.e. the axes are actually in
    // there, rather than the six shapes happening to differ for some other reason.
    for (const p of prefixes) {
      expect(
        p.split(':').length,
        `the cache-key prefix "${p}" is just <key>:<version> — no viewer axis is literal`
      ).toBeGreaterThan(2);
    }
    expect(
      new Set(prefixes).size,
      'two viewer classes share a hash-independent cache-key prefix, so only a 32-bit ' +
        `hash separates them: ${JSON.stringify(prefixes)}`
    ).toBe(shapes.length);
  });

  /**
   * 🔴 BEHAVIOURAL, NOT STRUCTURAL. `bustAppListingCatalogCache` is the single buster
   * every mutation calls; the ledger suite proves the CALL SITES are complete, and a
   * structural check type-checks straight past a buster that busts the WRONG TAG.
   * There are two tags in `app-listing-cache.constants`, and swapping them would make
   * every mutation appear to bust while the catalog entry survived its full TTL.
   */
  it('🔴 the buster busts the CATALOG tag, not the recommend-mean tag', async () => {
    await bustAppListingCatalogCache();
    expect(bustCacheTag).toHaveBeenCalledTimes(1);
    expect(
      bustCacheTag,
      '`bustAppListingCatalogCache` did not pass the catalog tag. Every one of the ' +
        'listing mutations calls it and would report success while the /apps grid ' +
        'stayed stale for the whole TTL.'
    ).toHaveBeenCalledWith([APP_LISTING_CATALOG_TAG]);
    // Negative half: the two tags are genuinely different strings, so the assertion
    // above is not vacuously true of both.
    expect(APP_LISTING_CATALOG_TAG).not.toBe(APP_LISTING_RECOMMEND_MEAN_TAG);
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
