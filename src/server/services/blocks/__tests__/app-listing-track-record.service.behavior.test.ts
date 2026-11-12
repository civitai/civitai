import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A developer's track record ("N apps · M reviews") and the "More by this developer" rail,
 * executed against an in-process Postgres with the real store predicate.
 *
 * The property: an app is counted, and its reviews summed, exactly when this viewer could find
 * it in the `/apps` store — and the rail lists the same set. Each excluded fixture below fails
 * the store predicate for a DIFFERENT reason, and each carries a distinct review total, so a
 * read that admits any one of them moves both numbers by an amount that names the row.
 *
 * The query cache is replaced by a pass-through that runs the cached statement on the PGlite
 * database and records the rows, so what is asserted is what the statement returns.
 */

const h = vi.hoisted(() => ({
  pg: null as unknown as {
    query: (text: string, values: unknown[]) => Promise<{ rows: Array<{ id?: string }> }>;
  },
  pages: [] as { key: string; rows: { id?: string }[] }[],
}));

vi.mock('~/client-utils/edge-url', () => ({ getEdgeUrl: (src: string) => src }));
vi.mock('~/env/server', () => ({ env: { APPS_DOMAIN: 'civit.ai' } }));
vi.mock('~/server/common/constants', () => ({ CacheTTL: { hour: 3600, sm: 180 } }));
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache:
    (_db: unknown, key: string) =>
    async (sql: Prisma.Sql): Promise<unknown[]> => {
      const { rows } = await h.pg.query(sql.text, sql.values as unknown[]);
      h.pages.push({ key, rows });
      return rows;
    },
  bustCacheTag: vi.fn(async () => undefined),
}));

const { getDeveloperTrackRecord } = await import(
  '~/server/services/blocks/app-listing-track-record.service'
);
const { listAvailableListings } = await import('~/server/services/blocks/app-listing.service');

const DEV = 4101;
const OTHER_DEV = 4202;
/** A banned developer: their apps leave the store with them (`storeOwnerEligibleWhere`). */
const BANNED_DEV = 4303;

const SCHEMA = (withVisibility: boolean) => `
  -- The listing owners: the store predicate admits a listing only while its owner exists and is
  -- neither banned nor deleted.
  CREATE TABLE "User" ("id" INT PRIMARY KEY, "bannedAt" TIMESTAMPTZ, "deletedAt" TIMESTAMPTZ);
  INSERT INTO "User" ("id", "bannedAt") VALUES
    (${DEV}, NULL), (${OTHER_DEV}, NULL), (${BANNED_DEV}, now());
  CREATE TABLE "app_blocks" (
    "id" TEXT PRIMARY KEY,
    "current_version_deployed_at" TIMESTAMPTZ
  );
  CREATE TABLE "app_listings" (
    "id" TEXT PRIMARY KEY,
    "slug" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    ${withVisibility ? '"visibility" TEXT,' : ''}
    "category" TEXT,
    "content_rating" TEXT,
    "user_id" INT NOT NULL,
    "app_block_id" TEXT UNIQUE REFERENCES "app_blocks"("id") ON DELETE SET NULL,
    "revision_of_id" TEXT REFERENCES "app_listings"("id") ON DELETE CASCADE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE "app_listing_metrics" (
    "app_listing_id" TEXT PRIMARY KEY REFERENCES "app_listings"("id") ON DELETE CASCADE,
    "thumbs_up_count" INT NOT NULL DEFAULT 0,
    "thumbs_down_count" INT NOT NULL DEFAULT 0,
    "install_count" INT NOT NULL DEFAULT 0,
    "open_count" INT NOT NULL DEFAULT 0
  );
`;

/** The developer's store-visible apps (to a SFW, public-floor, full-scope viewer). */
const VISIBLE = ['apl_dev_v1', 'apl_dev_v2', 'apl_dev_v3'];
/** Their review totals: 3+1, 5+0, and no metric row at all. */
const VISIBLE_REVIEWS = 9;

async function seed(pg: PGlite) {
  await pg.exec(`
    INSERT INTO "app_blocks" ("id", "current_version_deployed_at") VALUES
      ('ab_v1', now()), ('ab_v3', now()), ('ab_private', now()), ('ab_draft', now()),
      ('ab_removed', now()), ('ab_mature', now()), ('ab_pending', now()),
      ('ab_undeployed', NULL), ('ab_rejected', now()), ('ab_other', now()),
      ('ab_banned', now());
    INSERT INTO "app_listings"
      ("id", "slug", "name", "kind", "status", "visibility", "content_rating", "user_id", "app_block_id", "revision_of_id")
    VALUES
      ('apl_dev_v1', 'dev-v1', 'Dev One', 'onsite', 'approved', NULL, 'g', ${DEV}, 'ab_v1', NULL),
      ('apl_dev_v2', 'dev-v2', 'Dev Two', 'offsite', 'approved', 'public', 'pg', ${DEV}, NULL, NULL),
      ('apl_dev_v3', 'dev-v3', 'Dev Three', 'onsite', 'approved', NULL, 'g', ${DEV}, 'ab_v3', NULL),
      -- Each of these fails the store predicate for a different reason:
      ('apl_dev_private', 'dev-private', 'Private', 'onsite', 'approved', 'private', 'g', ${DEV}, 'ab_private', NULL),
      ('apl_dev_draft', 'dev-draft', 'Draft', 'onsite', 'draft', NULL, 'g', ${DEV}, 'ab_draft', NULL),
      ('apl_dev_removed', 'dev-removed', 'Removed', 'onsite', 'removed', NULL, 'g', ${DEV}, 'ab_removed', NULL),
      ('apl_dev_mature', 'dev-mature', 'Mature', 'onsite', 'approved', NULL, 'x', ${DEV}, 'ab_mature', NULL),
      ('apl_dev_pending', 'dev-pending', 'Pending', 'onsite', 'pending', NULL, 'g', ${DEV}, 'ab_pending', NULL),
      ('apl_dev_undeployed', 'dev-undeployed', 'Undeployed', 'onsite', 'approved', NULL, 'g', ${DEV}, 'ab_undeployed', NULL),
      ('apl_dev_rejected', 'dev-rejected', 'Rejected', 'onsite', 'rejected', NULL, 'g', ${DEV}, 'ab_rejected', NULL),
      -- A shadow revision of a visible app: a draft with a public level, never a store row.
      ('apl_dev_revision', 'dev-revision', 'Dev One (revision)', 'onsite', 'draft', 'public', 'g', ${DEV}, NULL, 'apl_dev_v1'),
      -- Another developer's visible app.
      ('apl_other_v1', 'other-v1', 'Other One', 'onsite', 'approved', NULL, 'g', ${OTHER_DEV}, 'ab_other', NULL),
      -- A banned developer's otherwise store-visible app.
      ('apl_banned_v1', 'banned-v1', 'Banned One', 'onsite', 'approved', NULL, 'g', ${BANNED_DEV}, 'ab_banned', NULL);
    INSERT INTO "app_listing_metrics"
      ("app_listing_id", "thumbs_up_count", "thumbs_down_count", "install_count", "open_count")
    VALUES
      ('apl_dev_v1', 3, 1, 10, 30),
      ('apl_dev_v2', 5, 0, 20, 0),
      -- Excluded rows carry distinct totals, so a leak names itself in the sum.
      ('apl_dev_private', 100, 0, 0, 0),
      ('apl_dev_draft', 200, 0, 0, 0),
      ('apl_dev_removed', 300, 0, 0, 0),
      ('apl_dev_mature', 400, 0, 0, 0),
      ('apl_dev_pending', 1000, 0, 0, 0),
      ('apl_dev_undeployed', 2000, 0, 0, 0),
      ('apl_dev_rejected', 4000, 0, 0, 0),
      ('apl_dev_revision', 8000, 0, 0, 0),
      ('apl_other_v1', 16000, 0, 0, 0),
      ('apl_banned_v1', 32000, 0, 0, 0);
  `);
}

const sfwPublic = {
  scope: 'full',
  floor: 'public',
  redCapable: false,
  viewerBrowsingLevel: 1,
} as const;

describe('with the visibility column', () => {
  const pg = new PGlite();

  beforeAll(async () => {
    h.pg = pg as never;
    await pg.exec(SCHEMA(true));
    await seed(pg);
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(() => {
    h.pages.length = 0;
  });

  it('🔴 counts only the store-visible apps, and sums only their reviews', async () => {
    await expect(getDeveloperTrackRecord({ userId: DEV, ...sfwPublic })).resolves.toEqual({
      appCount: VISIBLE.length,
      reviewCount: VISIBLE_REVIEWS,
    });
  });

  it('another developer is counted on their own', async () => {
    await expect(getDeveloperTrackRecord({ userId: OTHER_DEV, ...sfwPublic })).resolves.toEqual({
      appCount: 1,
      reviewCount: 16000,
    });
  });

  it("🔴 a banned developer's apps are not counted: their record is empty", async () => {
    await expect(getDeveloperTrackRecord({ userId: BANNED_DEV, ...sfwPublic })).resolves.toEqual({
      appCount: 0,
      reviewCount: 0,
    });
  });

  it('a developer with nothing visible has an empty record, not an error', async () => {
    await expect(getDeveloperTrackRecord({ userId: 999_999, ...sfwPublic })).resolves.toEqual({
      appCount: 0,
      reviewCount: 0,
    });
  });

  it('a mature app is counted only for a red-capable viewer whose level includes it', async () => {
    await expect(
      getDeveloperTrackRecord({
        userId: DEV,
        ...sfwPublic,
        redCapable: true,
        viewerBrowsingLevel: 7,
      })
    ).resolves.toEqual({ appCount: 3, reviewCount: VISIBLE_REVIEWS });
    await expect(
      getDeveloperTrackRecord({
        userId: DEV,
        ...sfwPublic,
        redCapable: true,
        viewerBrowsingLevel: 15,
      })
    ).resolves.toEqual({ appCount: 4, reviewCount: VISIBLE_REVIEWS + 400 });
  });

  it('the external-only store scope counts off-site apps only', async () => {
    await expect(
      getDeveloperTrackRecord({ userId: DEV, ...sfwPublic, scope: 'public-external' })
    ).resolves.toEqual({ appCount: 1, reviewCount: 5 });
  });

  it('🔴 the rail lists the same set: store-visible apps of this developer only', async () => {
    // The hydration below the id page reads through the global db mock, which is not under
    // test; the id page is the row set, so it is what is asserted.
    await listAvailableListings(
      { kind: 'all', sort: 'popular', limit: 10, userId: DEV },
      sfwPublic
    ).catch(() => undefined);
    const page = h.pages.find((p) => p.key.startsWith('listAvailableAppListings:'));
    expect(page, 'the rail never read its id page').toBeDefined();
    expect(page!.rows.map((r) => r.id).sort()).toEqual([...VISIBLE].sort());
  });

  it("🔴 a banned developer's rail is empty", async () => {
    await listAvailableListings(
      { kind: 'all', sort: 'popular', limit: 10, userId: BANNED_DEV },
      sfwPublic
    ).catch(() => undefined);
    const page = h.pages.find((p) => p.key.startsWith('listAvailableAppListings:'));
    expect(page, 'the rail never read its id page').toBeDefined();
    expect(page!.rows).toEqual([]);
  });

  // Also shows the banned developer's app is out of the unfiltered store page, while the
  // identically shaped app of an active developer is in it.
  it('positive control: without the developer the same page includes other developers', async () => {
    await listAvailableListings({ kind: 'all', sort: 'popular', limit: 10 }, sfwPublic).catch(
      () => undefined
    );
    const page = h.pages.find((p) => p.key.startsWith('listAvailableAppListings:'));
    expect(page!.rows.map((r) => r.id).sort()).toEqual([...VISIBLE, 'apl_other_v1'].sort());
  });
});

describe('before the visibility migration — the pre-feature predicate', () => {
  const pg = new PGlite();

  beforeAll(async () => {
    h.pg = pg as never;
    await pg.exec(SCHEMA(false));
    await pg.exec(`
      INSERT INTO "app_blocks" ("id", "current_version_deployed_at") VALUES ('ab_a', now()), ('ab_b', now());
      INSERT INTO "app_listings" ("id", "slug", "name", "kind", "status", "content_rating", "user_id", "app_block_id")
      VALUES
        ('apl_a', 'a', 'A', 'onsite', 'approved', 'g', ${DEV}, 'ab_a'),
        ('apl_b', 'b', 'B', 'onsite', 'draft', 'g', ${DEV}, 'ab_b');
      INSERT INTO "app_listing_metrics" ("app_listing_id", "thumbs_up_count", "thumbs_down_count")
      VALUES ('apl_a', 2, 2), ('apl_b', 50, 0);
    `);
  });
  afterAll(async () => {
    await pg.close();
  });

  it('a missing visibility column degrades to approved-only, never an error', async () => {
    await expect(getDeveloperTrackRecord({ userId: DEV, ...sfwPublic })).resolves.toEqual({
      appCount: 1,
      reviewCount: 4,
    });
  });
});
