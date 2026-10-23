import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import type { ForkRawClient } from '~/server/services/blocks/app-fork.service';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// `app-listing.service` (where the store predicate lives) is a large module; these are the mocks
// its import needs (`~/server/db/client` is the global canonical mock). Nothing here reaches
// them: the function under test takes its client as an argument.
vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache: () => async () => [],
  bustCacheTag: vi.fn(async () => undefined),
}));

const { listListingForks, EMPTY_FORKS_PAGE } = await import(
  '~/server/services/blocks/app-listing-forks.service'
);

/**
 * The fork COUNT and LIST on a parent's store page, executed against an in-process Postgres with
 * the real migration and the real store predicate (`storeEligibilityWhere` +
 * `listingLevelVisibilityFilter`, imported, not restated).
 *
 * The property: a fork is counted and listed exactly when this viewer could find it in the store —
 * and the count and the pages agree, because they share one WHERE clause. Each excluded fixture
 * below fails the store predicate for a DIFFERENT reason, so a mutant that drops any single term of
 * it moves the count.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261126120000_app_fork_provenance/migration.sql'
);

const BASE_SCHEMA = `
  CREATE TABLE "app_blocks" (
    "id" TEXT PRIMARY KEY,
    "block_id" TEXT NOT NULL UNIQUE,
    "current_version_deployed_at" TIMESTAMPTZ
  );
  CREATE TABLE "app_block_publish_requests" (
    "id" TEXT PRIMARY KEY,
    "app_block_id" TEXT REFERENCES "app_blocks"("id") ON DELETE SET NULL,
    "slug" TEXT NOT NULL,
    "status" TEXT NOT NULL
  );
  CREATE TABLE "app_listings" (
    "id" TEXT PRIMARY KEY,
    "slug" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "visibility" TEXT,
    "category" TEXT,
    "content_rating" TEXT,
    "app_block_id" TEXT UNIQUE REFERENCES "app_blocks"("id") ON DELETE SET NULL,
    "revision_of_id" TEXT REFERENCES "app_listings"("id") ON DELETE CASCADE,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

const PARENT = 'apl_parent_0100';
const OTHER_PARENT = 'apl_parent_0200';

/**
 * Forks of PARENT. Ids sort in creation order (`apl_<ULID>`), so the visible ones are newest-first
 * in the order v3, v2, v1.
 */
const VISIBLE = ['apl_fork_v1_0301', 'apl_fork_v2_0302', 'apl_fork_v3_0303'];

/** Prisma's tagged-template raw client over PGlite, as the service calls it. */
function rawClient(pg: PGlite): ForkRawClient {
  const raw = pgliteRaw(pg);
  return { $queryRaw: raw.queryRaw, $executeRaw: raw.executeRaw };
}

const sfwPublic = { scope: 'full', floor: 'public', redCapable: false } as const;

async function seed(pg: PGlite) {
  await pg.exec(`
    INSERT INTO "app_blocks" ("id", "block_id", "current_version_deployed_at") VALUES
      ('ab_parent_1100', 'parent-app', now()),
      ('ab_parent_1200', 'other-parent-app', now()),
      ('ab_v1_1301', 'fork-v1', now()),
      ('ab_v2_1302', 'fork-v2', now()),
      ('ab_v3_1303', 'fork-v3', now()),
      ('ab_pending_1401', 'fork-pending', now()),
      ('ab_undeployed_1402', 'fork-undeployed', NULL),
      ('ab_private_1403', 'fork-private', now()),
      ('ab_mature_1404', 'fork-mature', now()),
      ('ab_removed_1405', 'fork-removed', now()),
      ('ab_rejected_1406', 'fork-rejected', now()),
      ('ab_elsewhere_1407', 'fork-of-other', now());
    INSERT INTO "app_listings"
      ("id", "slug", "name", "kind", "status", "visibility", "content_rating", "app_block_id", "revision_of_id")
    VALUES
      ('${PARENT}', 'parent-app', 'Parent App', 'onsite', 'approved', NULL, 'g', 'ab_parent_1100', NULL),
      ('${OTHER_PARENT}', 'other-parent-app', 'Other Parent', 'onsite', 'approved', NULL, 'g', 'ab_parent_1200', NULL),
      ('apl_fork_v1_0301', 'fork-v1', 'Fork One', 'onsite', 'approved', NULL, 'g', 'ab_v1_1301', NULL),
      ('apl_fork_v2_0302', 'fork-v2', 'Fork Two', 'onsite', 'approved', 'public', 'pg', 'ab_v2_1302', NULL),
      ('apl_fork_v3_0303', 'fork-v3', 'Fork Three', 'onsite', 'approved', NULL, 'g', 'ab_v3_1303', NULL),
      -- Each of these fails the store predicate for a different reason:
      ('apl_fork_x1_0401', 'fork-pending', 'Pending Fork', 'onsite', 'pending', NULL, 'g', 'ab_pending_1401', NULL),
      ('apl_fork_x2_0402', 'fork-undeployed', 'Undeployed Fork', 'onsite', 'approved', NULL, 'g', 'ab_undeployed_1402', NULL),
      ('apl_fork_x3_0403', 'fork-private', 'Private Fork', 'onsite', 'approved', 'private', 'g', 'ab_private_1403', NULL),
      ('apl_fork_x4_0404', 'fork-mature', 'Mature Fork', 'onsite', 'approved', NULL, 'x', 'ab_mature_1404', NULL),
      ('apl_fork_x5_0405', 'fork-removed', 'Removed Fork', 'onsite', 'removed', NULL, 'g', 'ab_removed_1405', NULL),
      ('apl_fork_x6_0406', 'fork-rejected', 'Rejected Fork', 'onsite', 'rejected', NULL, 'g', 'ab_rejected_1406', NULL),
      -- A shadow revision of a visible fork (draft, no block) — never a store row.
      ('apl_fork_x7_0407', 'rev-fork-v1', 'Fork One (revision)', 'onsite', 'draft', 'public', 'g', NULL, 'apl_fork_v1_0301'),
      -- A visible fork of a DIFFERENT parent.
      ('apl_fork_x8_0408', 'fork-of-other', 'Other Parent Fork', 'onsite', 'approved', NULL, 'g', 'ab_elsewhere_1407', NULL);
  `);
}

async function linkForks(pg: PGlite) {
  await pg.exec(`
    UPDATE "app_listings" SET "fork_of_listing_id" = '${PARENT}'
      WHERE "id" LIKE 'apl_fork_v%' OR "id" IN (
        'apl_fork_x1_0401', 'apl_fork_x2_0402', 'apl_fork_x3_0403', 'apl_fork_x4_0404',
        'apl_fork_x5_0405', 'apl_fork_x6_0406', 'apl_fork_x7_0407');
    UPDATE "app_listings" SET "fork_of_listing_id" = '${OTHER_PARENT}' WHERE "id" = 'apl_fork_x8_0408';
  `);
}

describe('before the migration — no forks, never an error', () => {
  const pg = new PGlite();

  beforeAll(async () => {
    await pg.exec(BASE_SCHEMA);
    await seed(pg);
  });
  afterAll(async () => {
    await pg.close();
  });

  it('a missing fork column reads as an empty page', async () => {
    await expect(
      listListingForks(rawClient(pg), { parentListingId: PARENT, limit: 10, ...sfwPublic })
    ).resolves.toEqual(EMPTY_FORKS_PAGE);
  });
});

describe('with the migration applied', () => {
  const pg = new PGlite();
  const db = rawClient(pg);

  beforeAll(async () => {
    await pg.exec(BASE_SCHEMA);
    await pg.exec(readFileSync(MIGRATION, 'utf8'));
    await seed(pg);
    await linkForks(pg);
  });
  afterAll(async () => {
    await pg.close();
  });

  it('counts and lists only the forks this viewer could find in the store, newest first', async () => {
    const page = await listListingForks(db, { parentListingId: PARENT, limit: 10, ...sfwPublic });
    expect(page.totalCount).toBe(3);
    expect(page.items).toEqual([
      { id: 'apl_fork_v3_0303', slug: 'fork-v3', name: 'Fork Three' },
      { id: 'apl_fork_v2_0302', slug: 'fork-v2', name: 'Fork Two' },
      { id: 'apl_fork_v1_0301', slug: 'fork-v1', name: 'Fork One' },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('paginates by cursor: every visible fork exactly once, and the count is the whole set', async () => {
    const first = await listListingForks(db, { parentListingId: PARENT, limit: 2, ...sfwPublic });
    expect(first.totalCount).toBe(3);
    expect(first.items.map((f) => f.id)).toEqual(['apl_fork_v3_0303', 'apl_fork_v2_0302']);
    expect(first.nextCursor).toBe('apl_fork_v2_0302');

    const second = await listListingForks(db, {
      parentListingId: PARENT,
      limit: 2,
      cursor: first.nextCursor,
      ...sfwPublic,
    });
    expect(second.totalCount).toBe(3);
    expect(second.items.map((f) => f.id)).toEqual(['apl_fork_v1_0301']);
    expect(second.nextCursor).toBeNull();

    const walked = [...first.items, ...second.items].map((f) => f.id).sort();
    expect(walked).toEqual([...VISIBLE].sort());
  });

  it('a mature fork is listed on a red-capable host only', async () => {
    const red = await listListingForks(db, {
      parentListingId: PARENT,
      limit: 10,
      scope: 'full',
      floor: 'public',
      redCapable: true,
    });
    expect(red.totalCount).toBe(4);
    expect(red.items.map((f) => f.id)).toContain('apl_fork_x4_0404');
  });

  it('an external-only store scope sees no on-site forks', async () => {
    await expect(
      listListingForks(db, {
        parentListingId: PARENT,
        limit: 10,
        scope: 'public-external',
        floor: 'public',
        redCapable: false,
      })
    ).resolves.toEqual({ totalCount: 0, items: [], nextCursor: null });
  });

  it('forks of a different parent are never counted', async () => {
    const other = await listListingForks(db, {
      parentListingId: OTHER_PARENT,
      limit: 10,
      ...sfwPublic,
    });
    expect(other).toEqual({
      totalCount: 1,
      items: [{ id: 'apl_fork_x8_0408', slug: 'fork-of-other', name: 'Other Parent Fork' }],
      nextCursor: null,
    });
  });
});
