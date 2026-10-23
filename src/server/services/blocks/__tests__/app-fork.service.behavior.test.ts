import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ForkRawClient } from '~/server/services/blocks/app-fork.service';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The degraded paths log through `~/server/logging/client`, which the global test setup
// replaces with its canonical mock (src/__tests__/setup.ts); nothing here asserts on it.

const {
  FORKABLE_UNAVAILABLE,
  ForkProvenanceError,
  NO_FORK_PROVENANCE,
  applyForkProvenanceOnApprove,
  carryForkProvenanceToPublishRequest,
  readListingForkProvenance,
  readListingForkable,
  resolveForkAttribution,
  setAppBlockForkProvenance,
  setPublishRequestForkProvenance,
  writeListingForkable,
} = await import('~/server/services/blocks/app-fork.service');

/**
 * Fork provenance, EXECUTED against an in-process Postgres carrying the real migration.
 *
 * Every read and write in `app-fork.service` is raw SQL over columns the Prisma client does not
 * know (they are stripped from it on purpose), so a mocked client cannot see a single one of the
 * properties that matter here: the foreign keys' ON DELETE SET NULL, the self-reference CHECK, the
 * write-once guards, the join that links a fork's listing to its parent's, and — the one this
 * file exists for — that the approve reads the parent ONLY from the request's own columns and
 * never from the author-controlled manifest.
 *
 * The tables are cut down to the columns these statements touch; the migration under test is the
 * committed file, applied verbatim (twice — it must be idempotent).
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations/20261126120000_app_fork_provenance/migration.sql'
);

/** The pre-feature tables, as far as these statements read them. */
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
    "status" TEXT NOT NULL,
    "manifest" JSONB NOT NULL DEFAULT '{}'::jsonb
  );
  CREATE TABLE "app_listings" (
    "id" TEXT PRIMARY KEY,
    "slug" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "app_block_id" TEXT UNIQUE REFERENCES "app_blocks"("id") ON DELETE SET NULL,
    "revision_of_id" TEXT REFERENCES "app_listings"("id") ON DELETE CASCADE,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

/** Prisma's tagged-template raw client over PGlite, as the service calls it. */
function rawClient(pg: PGlite): ForkRawClient {
  const raw = pgliteRaw(pg);
  return { $queryRaw: raw.queryRaw, $executeRaw: raw.executeRaw };
}

// Pairwise-distinct fixture ids — no two fixtures (and no constant the assertions name) share a
// value, so an assertion can never pass by matching the wrong row.
const PARENT_BLOCK = 'ab_parent_0001';
const FORK_BLOCK = 'ab_fork_0002';
const OTHER_BLOCK = 'ab_other_0003';
const PARENT_LISTING = 'apl_parent_0011';
const FORK_LISTING = 'apl_fork_0012';
const OTHER_LISTING = 'apl_other_0013';
const PARENT_SHADOW = 'apl_shadow_0014';
const FORK_REQUEST = 'pubreq_fork_0021';
const FORGED_REQUEST = 'pubreq_forged_0022';
const NEXT_REQUEST = 'pubreq_next_0023';
const PLAIN_REQUEST = 'pubreq_plain_0024';
const PARENT_SHA = 'a'.repeat(40);

async function seed(pg: PGlite) {
  await pg.exec(`
    TRUNCATE "app_listings", "app_block_publish_requests", "app_blocks" CASCADE;
    INSERT INTO "app_blocks" ("id", "block_id") VALUES
      ('${PARENT_BLOCK}', 'parent-app'),
      ('${FORK_BLOCK}', 'fork-app'),
      ('${OTHER_BLOCK}', 'other-app');
    INSERT INTO "app_listings" ("id", "slug", "name", "kind", "status", "app_block_id", "revision_of_id") VALUES
      ('${PARENT_LISTING}', 'parent-app', 'Parent App', 'onsite', 'approved', '${PARENT_BLOCK}', NULL),
      ('${FORK_LISTING}', 'fork-app', 'Fork App', 'onsite', 'approved', '${FORK_BLOCK}', NULL),
      ('${OTHER_LISTING}', 'other-app', 'Other App', 'onsite', 'approved', '${OTHER_BLOCK}', NULL),
      ('${PARENT_SHADOW}', 'rev-parent', 'Parent App (revision)', 'onsite', 'draft', NULL, '${PARENT_LISTING}');
    INSERT INTO "app_block_publish_requests" ("id", "app_block_id", "slug", "status", "manifest") VALUES
      ('${FORK_REQUEST}', NULL, 'fork-app', 'pending', '{}'),
      ('${PLAIN_REQUEST}', '${OTHER_BLOCK}', 'other-app', 'pending', '{}');
  `);
}

async function col<T>(pg: PGlite, sql: string): Promise<T> {
  const res = await pg.query<Record<string, T>>(sql);
  return Object.values(res.rows[0] ?? {})[0] as T;
}

describe('before the migration is applied — every read degrades, nothing throws', () => {
  const pg = new PGlite();
  const db = rawClient(pg);

  beforeAll(async () => {
    await pg.exec(BASE_SCHEMA);
    await seed(pg);
  });
  afterAll(async () => {
    await pg.close();
  });

  it('the opt-in read reports UNAVAILABLE (so the write is refused, not attempted)', async () => {
    await expect(readListingForkable(PARENT_LISTING, db)).resolves.toEqual(FORKABLE_UNAVAILABLE);
  });

  it('the provenance read reads "not a fork"', async () => {
    await expect(readListingForkProvenance(FORK_LISTING, db)).resolves.toEqual(NO_FORK_PROVENANCE);
  });

  it('the carry on request creation is a silent no-op (a submit never fails on it)', async () => {
    await expect(
      carryForkProvenanceToPublishRequest(db, { publishRequestId: FORK_REQUEST, slug: 'fork-app' })
    ).resolves.toBe(false);
  });

  it('the approve step reports unavailable instead of throwing', async () => {
    await expect(
      applyForkProvenanceOnApprove(db, { publishRequestId: FORK_REQUEST, appBlockId: FORK_BLOCK })
    ).resolves.toBe('unavailable');
  });
});

describe('with the migration applied', () => {
  const pg = new PGlite();
  const db = rawClient(pg);

  beforeAll(async () => {
    await pg.exec(BASE_SCHEMA);
    const sql = readFileSync(MIGRATION, 'utf8');
    await pg.exec(sql);
    // Idempotent: a second application is a no-op, not an error.
    await pg.exec(sql);
  });
  afterAll(async () => {
    await pg.close();
  });
  beforeEach(async () => {
    await seed(pg);
  });

  describe('the author opt-in', () => {
    it('defaults to off, and a write to the live listing reads back', async () => {
      await expect(readListingForkable(PARENT_LISTING, db)).resolves.toEqual({
        available: true,
        forkable: false,
      });
      await expect(writeListingForkable(db, PARENT_LISTING, true)).resolves.toBe(1);
      await expect(readListingForkable(PARENT_LISTING, db)).resolves.toEqual({
        available: true,
        forkable: true,
      });
      await expect(writeListingForkable(db, PARENT_LISTING, false)).resolves.toBe(1);
      await expect(readListingForkable(PARENT_LISTING, db)).resolves.toEqual({
        available: true,
        forkable: false,
      });
    });

    it('is never written to a shadow revision', async () => {
      await expect(writeListingForkable(db, PARENT_SHADOW, true)).resolves.toBe(0);
      expect(
        await col<boolean>(
          pg,
          `SELECT "forkable" FROM "app_listings" WHERE "id" = '${PARENT_SHADOW}'`
        )
      ).toBe(false);
    });
  });

  describe('approve carry-through', () => {
    it('links the fork’s listing to the parent’s listing and stamps the block', async () => {
      await expect(
        setPublishRequestForkProvenance(db, {
          publishRequestId: FORK_REQUEST,
          forkOfAppBlockId: PARENT_BLOCK,
          forkOfCommitSha: PARENT_SHA,
        })
      ).resolves.toBe(true);

      await expect(
        applyForkProvenanceOnApprove(db, { publishRequestId: FORK_REQUEST, appBlockId: FORK_BLOCK })
      ).resolves.toBe('linked');

      expect(
        await col<string | null>(
          pg,
          `SELECT "fork_of_listing_id" FROM "app_listings" WHERE "id" = '${FORK_LISTING}'`
        )
      ).toBe(PARENT_LISTING);
      const block = await pg.query<{ p: string | null; s: string | null }>(
        `SELECT "fork_of_app_block_id" AS p, "fork_of_commit_sha" AS s FROM "app_blocks" WHERE "id" = '${FORK_BLOCK}'`
      );
      expect(block.rows[0]).toEqual({ p: PARENT_BLOCK, s: PARENT_SHA });
      // The parent's own rows are untouched, and its shadow never becomes a link target.
      expect(
        await col<string | null>(
          pg,
          `SELECT "fork_of_listing_id" FROM "app_listings" WHERE "id" = '${PARENT_LISTING}'`
        )
      ).toBeNull();

      // Re-approve converges without rewriting anything.
      await expect(
        applyForkProvenanceOnApprove(db, { publishRequestId: FORK_REQUEST, appBlockId: FORK_BLOCK })
      ).resolves.toBe('no-listing-link');
      expect(
        await col<string | null>(
          pg,
          `SELECT "fork_of_listing_id" FROM "app_listings" WHERE "id" = '${FORK_LISTING}'`
        )
      ).toBe(PARENT_LISTING);
    });

    it('🔴 FORGERY: a manifest that declares a parent is ignored — only the request’s own columns count', async () => {
      // Every spelling an author might try, pointing at a real parent. The request's server-written
      // columns are NULL, so this app is not a fork.
      await pg.query(
        `INSERT INTO "app_block_publish_requests" ("id", "app_block_id", "slug", "status", "manifest")
         VALUES ($1, $2, 'other-app', 'pending', $3::jsonb)`,
        [
          FORGED_REQUEST,
          OTHER_BLOCK,
          JSON.stringify({
            forkOf: PARENT_BLOCK,
            forkOfAppBlockId: PARENT_BLOCK,
            fork_of_app_block_id: PARENT_BLOCK,
            forkOfCommitSha: PARENT_SHA,
            forkOfListingId: PARENT_LISTING,
          }),
        ]
      );

      const outcome = await applyForkProvenanceOnApprove(db, {
        publishRequestId: FORGED_REQUEST,
        appBlockId: OTHER_BLOCK,
      });

      expect(outcome).toBe('not-a-fork');
      expect(
        await col<string | null>(
          pg,
          `SELECT "fork_of_listing_id" FROM "app_listings" WHERE "id" = '${OTHER_LISTING}'`
        )
      ).toBeNull();
      const block = await pg.query<{ p: string | null; s: string | null }>(
        `SELECT "fork_of_app_block_id" AS p, "fork_of_commit_sha" AS s FROM "app_blocks" WHERE "id" = '${OTHER_BLOCK}'`
      );
      expect(block.rows[0]).toEqual({ p: null, s: null });
    });

    it('an ordinary request (no provenance) is not a fork and writes nothing', async () => {
      await expect(
        applyForkProvenanceOnApprove(db, {
          publishRequestId: PLAIN_REQUEST,
          appBlockId: OTHER_BLOCK,
        })
      ).resolves.toBe('not-a-fork');
    });

    it('a later version carries the block’s provenance onto its new request', async () => {
      await setAppBlockForkProvenance(db, {
        appBlockId: FORK_BLOCK,
        forkOfAppBlockId: PARENT_BLOCK,
        forkOfCommitSha: PARENT_SHA,
      });
      await pg.query(
        `INSERT INTO "app_block_publish_requests" ("id", "app_block_id", "slug", "status") VALUES ($1, $2, 'fork-app', 'pending')`,
        [NEXT_REQUEST, FORK_BLOCK]
      );

      await expect(
        carryForkProvenanceToPublishRequest(db, {
          publishRequestId: NEXT_REQUEST,
          slug: 'fork-app',
        })
      ).resolves.toBe(true);
      const req = await pg.query<{ p: string | null; s: string | null }>(
        `SELECT "fork_of_app_block_id" AS p, "fork_of_commit_sha" AS s FROM "app_block_publish_requests" WHERE "id" = '${NEXT_REQUEST}'`
      );
      expect(req.rows[0]).toEqual({ p: PARENT_BLOCK, s: PARENT_SHA });

      // A request for an app that is not a fork carries nothing.
      await expect(
        carryForkProvenanceToPublishRequest(db, {
          publishRequestId: PLAIN_REQUEST,
          slug: 'other-app',
        })
      ).resolves.toBe(false);
    });
  });

  describe('parent deleted', () => {
    it('ON DELETE SET NULL clears the link, and the listing still reads as a fork (generic attribution)', async () => {
      await setPublishRequestForkProvenance(db, {
        publishRequestId: FORK_REQUEST,
        forkOfAppBlockId: PARENT_BLOCK,
        forkOfCommitSha: PARENT_SHA,
      });
      await applyForkProvenanceOnApprove(db, {
        publishRequestId: FORK_REQUEST,
        appBlockId: FORK_BLOCK,
      });

      // Delete the parent LISTING: the fork's link goes NULL rather than blocking the delete.
      await pg.query(`DELETE FROM "app_listings" WHERE "id" = $1`, [PARENT_LISTING]);
      const afterListingDelete = await readListingForkProvenance(FORK_LISTING, db);
      expect(afterListingDelete).toEqual({ forkable: false, forkOfListingId: null, isFork: true });
      await expect(
        resolveForkAttribution(afterListingDelete, async () => {
          throw new Error('must not look up a parent there is no id for');
        })
      ).resolves.toEqual({ visible: false });

      // Delete the parent BLOCK too: the block FK goes NULL, the commit sha (no FK) survives, and
      // the listing still reads as a fork.
      await pg.query(`DELETE FROM "app_blocks" WHERE "id" = $1`, [PARENT_BLOCK]);
      expect(
        await col<string | null>(
          pg,
          `SELECT "fork_of_app_block_id" FROM "app_blocks" WHERE "id" = '${FORK_BLOCK}'`
        )
      ).toBeNull();
      await expect(readListingForkProvenance(FORK_LISTING, db)).resolves.toEqual({
        forkable: false,
        forkOfListingId: null,
        isFork: true,
      });
    });
  });

  describe('server-side setters', () => {
    it('are write-once', async () => {
      const args = {
        appBlockId: FORK_BLOCK,
        forkOfAppBlockId: PARENT_BLOCK,
        forkOfCommitSha: PARENT_SHA,
      };
      await expect(setAppBlockForkProvenance(db, args)).resolves.toBe(true);
      await expect(
        setAppBlockForkProvenance(db, { ...args, forkOfAppBlockId: OTHER_BLOCK })
      ).resolves.toBe(false);
      expect(
        await col<string>(
          pg,
          `SELECT "fork_of_app_block_id" FROM "app_blocks" WHERE "id" = '${FORK_BLOCK}'`
        )
      ).toBe(PARENT_BLOCK);
    });

    it('refuse a self-fork, a malformed sha, and a parent that does not exist', async () => {
      await expect(
        setAppBlockForkProvenance(db, {
          appBlockId: FORK_BLOCK,
          forkOfAppBlockId: FORK_BLOCK,
          forkOfCommitSha: PARENT_SHA,
        })
      ).rejects.toBeInstanceOf(ForkProvenanceError);
      await expect(
        setAppBlockForkProvenance(db, {
          appBlockId: FORK_BLOCK,
          forkOfAppBlockId: PARENT_BLOCK,
          forkOfCommitSha: 'not-a-sha',
        })
      ).rejects.toBeInstanceOf(ForkProvenanceError);
      await expect(
        setAppBlockForkProvenance(db, {
          appBlockId: FORK_BLOCK,
          forkOfAppBlockId: 'ab_missing_0099',
          forkOfCommitSha: PARENT_SHA,
        })
      ).resolves.toBe(false);
      // A request whose own block IS the claimed parent is refused too.
      await expect(
        setPublishRequestForkProvenance(db, {
          publishRequestId: PLAIN_REQUEST,
          forkOfAppBlockId: OTHER_BLOCK,
          forkOfCommitSha: PARENT_SHA,
        })
      ).resolves.toBe(false);
    });

    it('the database refuses a listing that names itself as its parent', async () => {
      await expect(
        pg.query(`UPDATE "app_listings" SET "fork_of_listing_id" = "id" WHERE "id" = $1`, [
          FORK_LISTING,
        ])
      ).rejects.toMatchObject({ code: '23514' });
    });
  });
});

describe('resolveForkAttribution — never discloses a hidden parent', () => {
  const fork = { forkable: false, forkOfListingId: PARENT_LISTING, isFork: true };

  it('a parent the viewer may see is named and linked', async () => {
    await expect(
      resolveForkAttribution(fork, async (id) =>
        id === PARENT_LISTING ? { slug: 'parent-app', name: 'Parent App' } : null
      )
    ).resolves.toEqual({ visible: true, slug: 'parent-app', name: 'Parent App' });
  });

  it('a parent the viewer may not see reads exactly like a deleted one', async () => {
    await expect(resolveForkAttribution(fork, async () => null)).resolves.toEqual({
      visible: false,
    });
  });

  it('a failing lookup reads the same, never as an error', async () => {
    await expect(
      resolveForkAttribution(fork, async () => {
        throw new Error('replica timeout');
      })
    ).resolves.toEqual({ visible: false });
  });

  it('a listing that is not a fork has no attribution and triggers no lookup', async () => {
    const lookup = vi.fn(async () => ({ slug: 'x', name: 'y' }));
    await expect(resolveForkAttribution(NO_FORK_PROVENANCE, lookup)).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });
});
