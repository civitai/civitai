import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as PlacementEscrow from '~/server/services/placement-escrow.service';
import type * as PlacementService from '~/server/services/placement.service';

/**
 * Which rows the storyline continuation statements select, run against a real PostgreSQL.
 *
 * The unit tests for these functions mock `$queryRaw`, so every filter in the three statements
 * below is invisible to them: a dropped condition passes. This suite seeds rows that each one
 * condition decides, runs the real statement through a real Prisma client (so parameters bind
 * as they do in production), and compares the selected ids exactly.
 *
 * Only the selection is under test. Everything the functions do after it is stubbed: the ORM
 * reads return nothing and the escrow is reported funded, so nothing is settled.
 *
 * Opt-in via `STORYLINE_SQL_TEST_DATABASE_URL`, which must point at a THROWAWAY database: the
 * suite drops and recreates the public schema. It deliberately does NOT fall back to
 * `DATABASE_URL`, which names a real environment in any checkout that has one. Before wiping, it
 * refuses a database holding any table it does not create, or more rows than it writes.
 *
 *   docker run -d --rm --name pg-storyline-sql -e POSTGRES_PASSWORD=postgres \
 *     -e POSTGRES_DB=storyline -p 127.0.0.1:54331:5432 postgres:16-alpine
 *   STORYLINE_SQL_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54331/storyline \
 *     pnpm vitest run --project 'unit*' src/server/services/__tests__/storyline-continuation-sql.test.ts
 *   docker stop pg-storyline-sql
 *
 * Run it whenever one of the three statements changes.
 */
const testDatabaseUrl = process.env.STORYLINE_SQL_TEST_DATABASE_URL;

const settlePlacement = vi.fn();
const isPlacementEscrowFunded = vi.fn();
vi.mock('~/server/services/placement-escrow.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementEscrow>()),
  settlePlacement,
  isPlacementEscrowFunded,
}));
vi.mock('~/server/services/placement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementService>()),
  getPlacementConfig: async () => ({ expiryHours: () => 168 }),
}));

const {
  getPendingStorylineContinuations,
  settleStaleUnfundedContinuations,
  startReadyStorylineContinuations,
} = await import('~/server/services/storyline-placement.service');

const migrationSql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/civitai-db-schema/prisma/migrations/20260803210000_add_placement_foundation/migration.sql'
  ),
  'utf8'
);
/** The shipped index, read from the migration rather than restated. */
const holdKindUnique = migrationSql.match(
  /CREATE UNIQUE INDEX IF NOT EXISTS "PlacementTransaction_placementId_kind_key"\s+ON "PlacementTransaction" \("placementId", "kind"\);/
)?.[0];

const OWN_TABLES = new Set(['Post', 'Image', 'Placement', 'PlacementTransaction']);
const MAX_OWN_ROWS = 100;

// Column types follow schema.full.prisma (DateTime is TIMESTAMP(3) without a zone, written in
// UTC as Prisma writes it). Only the columns the statements read are created.
const SCHEMA = [
  `DROP SCHEMA public CASCADE`,
  `CREATE SCHEMA public`,
  `CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan')`,
  `CREATE TABLE "Post" (
     id INTEGER PRIMARY KEY, "publishedAt" TIMESTAMP(3),
     "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "tosViolation" BOOLEAN NOT NULL DEFAULT false)`,
  `CREATE TABLE "Image" (
     id SERIAL PRIMARY KEY, "postId" INTEGER, "tosViolation" BOOLEAN NOT NULL DEFAULT false,
     minor BOOLEAN NOT NULL DEFAULT false, poi BOOLEAN NOT NULL DEFAULT false,
     ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Pending', "needsReview" TEXT)`,
  `CREATE TABLE "Placement" (
     id INTEGER PRIMARY KEY, surface TEXT NOT NULL, "targetType" TEXT NOT NULL,
     "targetId" INTEGER NOT NULL, "ownerId" INTEGER NOT NULL, "placerId" INTEGER NOT NULL,
     data JSONB NOT NULL DEFAULT '{}', status TEXT NOT NULL, amount INTEGER NOT NULL,
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'), "expiresAt" TIMESTAMP(3))`,
  `CREATE TABLE "PlacementTransaction" (
     id SERIAL PRIMARY KEY, "placementId" INTEGER NOT NULL, kind TEXT NOT NULL,
     "transactionId" TEXT, amount INTEGER NOT NULL, "lastAttemptAt" TIMESTAMP(3),
     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'))`,
];

const ago = (minutes: number) => `(now() AT TIME ZONE 'UTC') - interval '${minutes} minutes'`;
const AWAITING = `'{"awaitingReadiness": true, "postId": %}'`;

type Row = {
  id: number;
  postId?: number;
  awaiting?: boolean;
  amount?: number;
  status?: string;
  surface?: string;
  ownerId?: number;
  createdAt?: string;
};
const placement = ({
  id,
  postId = 1001,
  awaiting = false,
  amount = 0,
  status = 'pending',
  surface = 'storyline',
  ownerId = 1,
  createdAt = ago(0),
}: Row) =>
  `INSERT INTO "Placement" (id, surface, "targetType", "targetId", "ownerId", "placerId", data, status, amount, "createdAt")
   VALUES (${id}, '${surface}', 'post', 500, ${ownerId}, 2, ${
    awaiting ? AWAITING.replace('%', String(postId)) : `'{"postId": ${postId}}'`
  }, '${status}', ${amount}, ${createdAt})`;

type Leg = {
  placementId: number;
  kind: string;
  amount: number;
  receipted?: boolean;
  lastAttemptAt?: string;
  createdAt?: string;
};
const leg = ({
  placementId,
  kind,
  amount,
  receipted = true,
  lastAttemptAt,
  createdAt = ago(0),
}: Leg) =>
  `INSERT INTO "PlacementTransaction" ("placementId", kind, "transactionId", amount, "lastAttemptAt", "createdAt")
   VALUES (${placementId}, '${kind}', ${
    receipted ? `'tx-${placementId}-${kind}'` : 'NULL'
  }, ${amount}, ${lastAttemptAt ?? 'NULL'}, ${createdAt})`;
const funded = (placementId: number, amount: number) => [
  leg({ placementId, kind: 'holdFee', amount: Math.round(amount * 0.3) }),
  leg({ placementId, kind: 'holdPrincipal', amount: amount - Math.round(amount * 0.3) }),
];

const PAST = ago(60);
const FIXTURE = [
  // Posts. 1001 is ready: published, rated, every image scanned and not in review. Each doomed
  // post is otherwise unrated, so only the condition that dooms it can select it.
  `INSERT INTO "Post" (id, "publishedAt", "nsfwLevel", "tosViolation") VALUES
     (1001, ${PAST}, 1, false), (1002, ${PAST}, 1, false), (1003, ${PAST}, 1, false),
     (1004, ${PAST}, 0, true),  (1005, ${PAST}, 1, false), (1006, ${PAST}, 0, false),
     (1007, ${ago(-60)}, 1, false), (1008, ${PAST}, 1, false), (1009, ${PAST}, 32, false),
     (1010, ${PAST}, 1, false), (1011, ${PAST}, 0, false), (1012, NULL, 1, false),
     (1013, ${PAST}, 0, false), (1014, ${PAST}, 0, false)`,
  `INSERT INTO "Image" ("postId", ingestion, "needsReview", "tosViolation", minor, poi) VALUES
     (1001, 'Scanned', NULL, false, false, false), (1001, 'Scanned', NULL, false, false, false),
     (1002, 'Scanned', NULL, false, false, false), (1002, 'Scanned', 'minor', false, false, false),
     (1003, 'Scanned', NULL, false, false, false), (1003, 'Pending', NULL, false, false, false),
     (1004, 'Scanned', NULL, false, false, false),
     (1005, 'Scanned', NULL, false, false, false), (1005, 'Blocked', NULL, false, false, false),
     (1006, 'Scanned', NULL, false, false, false),
     (1007, 'Scanned', NULL, false, false, false),
     (1009, 'Scanned', NULL, false, false, false),
     (1010, 'Scanned', NULL, false, false, false),
     (1011, 'Scanned', NULL, false, true, false),
     (1012, 'Scanned', NULL, false, false, false),
     (1013, 'Scanned', NULL, true, false, false),
     (1014, 'Scanned', NULL, false, false, true)`,

  // Readiness (1xx): pending, awaiting its post.
  placement({ id: 101, awaiting: true }),
  placement({ id: 102, awaiting: true, amount: 100 }),
  ...funded(102, 100),
  placement({ id: 103, awaiting: true, amount: 100 }), // unfunded: the fee only
  leg({ placementId: 103, kind: 'holdFee', amount: 30 }),
  placement({ id: 104, awaiting: true, amount: 100 }), // the principal leg claimed, not receipted
  leg({ placementId: 104, kind: 'holdFee', amount: 30 }),
  leg({ placementId: 104, kind: 'holdPrincipal', amount: 70, receipted: false }),
  placement({ id: 105, awaiting: true, amount: 100 }), // a receipted non-hold leg does not fund it
  leg({ placementId: 105, kind: 'holdFee', amount: 30 }),
  leg({ placementId: 105, kind: 'feeToOwner', amount: 70 }),
  placement({ id: 106, awaiting: true, postId: 1002 }), // an image in review
  placement({ id: 107, awaiting: true, postId: 1003 }), // an image still scanning
  placement({ id: 108, awaiting: true, postId: 1004 }), // doomed: post ToS
  placement({ id: 109, awaiting: true, postId: 1005 }), // doomed: an image blocked
  placement({ id: 110, awaiting: true, postId: 1006 }), // not yet rated
  placement({ id: 111, awaiting: true, postId: 1007 }), // scheduled
  placement({ id: 112, awaiting: true, postId: 1008 }), // no images
  placement({ id: 113, awaiting: true, postId: 9999 }), // post gone
  placement({ id: 114, awaiting: true, postId: 1009 }), // above the storyline's rating
  placement({ id: 115, awaiting: true, postId: 1010 }), // already a chapter elsewhere
  placement({ id: 116, awaiting: true, postId: 1011 }), // doomed: an image flagged minor
  placement({ id: 117 }), // already admitted
  placement({ id: 118, awaiting: true, status: 'approved' }),
  placement({ id: 119, awaiting: true, surface: 'sticker' }),
  placement({ id: 120, awaiting: true, postId: 1004, amount: 100 }), // doomed but unfunded
  leg({ placementId: 120, kind: 'holdFee', amount: 30 }),
  placement({ id: 121, awaiting: true, postId: 1012 }), // a draft
  placement({ id: 122, awaiting: true, postId: 1013 }), // doomed: an image ToS
  placement({ id: 123, awaiting: true, postId: 1014 }), // doomed: an image of a real person

  // Owner queue (2xx): owner 7.
  placement({ id: 201, ownerId: 7, createdAt: ago(180) }),
  placement({ id: 202, ownerId: 7, createdAt: ago(120) }),
  `INSERT INTO "Placement" (id, surface, "targetType", "targetId", "ownerId", "placerId", data, status, amount, "createdAt")
   SELECT 203, surface, "targetType", "targetId", "ownerId", "placerId", data, status, amount, "createdAt"
   FROM "Placement" WHERE id = 202`, // ties 202 on createdAt
  placement({ id: 204, ownerId: 8, createdAt: ago(170) }),
  placement({ id: 205, ownerId: 7, awaiting: true, postId: 1007, createdAt: ago(160) }),
  placement({ id: 206, ownerId: 7, postId: 9999, createdAt: ago(150) }),
  placement({ id: 207, ownerId: 7, postId: 1004, createdAt: ago(140) }),
  placement({ id: 208, ownerId: 7, status: 'declined', createdAt: ago(130) }),
  placement({ id: 209, ownerId: 7, createdAt: ago(60) }),
  placement({ id: 210, ownerId: 7, surface: 'sticker', createdAt: ago(110) }),

  // Stale unfunded sweep (3xx): priced, pending, not awaiting.
  placement({ id: 301, amount: 100, createdAt: ago(20) }), // no legs at all
  placement({ id: 302, amount: 100, createdAt: ago(10) }), // too fresh
  placement({ id: 303, amount: 100, createdAt: ago(20) }),
  ...funded(303, 100),
  placement({ id: 304, createdAt: ago(20) }), // free
  placement({ id: 305, amount: 100, createdAt: ago(20) }), // a leg attempted 5 minutes ago
  leg({ placementId: 305, kind: 'holdFee', amount: 30 }),
  leg({
    placementId: 305,
    kind: 'holdPrincipal',
    amount: 70,
    receipted: false,
    lastAttemptAt: ago(5),
    createdAt: ago(19),
  }),
  placement({ id: 306, amount: 100, createdAt: ago(120) }), // a leg last attempted 45 minutes ago
  leg({ placementId: 306, kind: 'holdFee', amount: 30 }),
  leg({
    placementId: 306,
    kind: 'holdPrincipal',
    amount: 70,
    receipted: false,
    lastAttemptAt: ago(45),
    createdAt: ago(119),
  }),
  placement({ id: 307, amount: 100, createdAt: ago(20) }), // a leg claimed 5 minutes ago, never attempted
  leg({ placementId: 307, kind: 'holdPrincipal', amount: 70, receipted: false, createdAt: ago(5) }),
  placement({ id: 308, amount: 100, createdAt: ago(120) }), // a leg claimed 45 minutes ago, never attempted
  leg({
    placementId: 308,
    kind: 'holdPrincipal',
    amount: 70,
    receipted: false,
    createdAt: ago(45),
  }),
  placement({ id: 309, amount: 100, status: 'approved', createdAt: ago(20) }),
  placement({ id: 310, amount: 100, surface: 'sticker', createdAt: ago(20) }),
  placement({ id: 311, amount: 100, createdAt: ago(20) }), // the fee only
  leg({ placementId: 311, kind: 'holdFee', amount: 30 }),
  placement({ id: 312, amount: 100, createdAt: ago(20) }), // a non-hold leg for the whole amount
  leg({ placementId: 312, kind: 'feeToOwner', amount: 100 }),
];

async function assertThrowaway(prisma: PrismaClient) {
  const tables = await prisma.$queryRaw<{ schema: string; name: string }[]>`
    SELECT n.nspname AS schema, cl.relname AS name
    FROM pg_class cl JOIN pg_namespace n ON n.oid = cl.relnamespace
    WHERE cl.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')`;
  const foreign = tables.filter((t) => t.schema !== 'public' || !OWN_TABLES.has(t.name));
  if (foreign.length)
    throw new Error(
      `refusing to wipe: ${foreign.length} table(s) this test did not create (${foreign
        .slice(0, 3)
        .map((t) => `${t.schema}.${t.name}`)
        .join(', ')})`
    );
  for (const { name } of tables) {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM (SELECT 1 FROM public."${name}" LIMIT ${MAX_OWN_ROWS + 1}) t`
    );
    if (n > MAX_OWN_ROWS)
      throw new Error(`refusing to wipe: public."${name}" has more rows than this test writes`);
  }
}

describe.skipIf(!testDatabaseUrl)('storyline continuation statements on PostgreSQL', () => {
  const prisma = new PrismaClient({ datasourceUrl: testDatabaseUrl });
  let selected: unknown[][] = [];

  beforeAll(async () => {
    await assertThrowaway(prisma);
    for (const statement of [...SCHEMA, ...FIXTURE]) await prisma.$executeRawUnsafe(statement);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    selected = [];
    const real = (client: 'dbRead' | 'dbWrite') =>
      dbMock[client].$queryRaw.mockImplementation(async (...args: unknown[]) => {
        const rows = await (prisma.$queryRaw as (...a: unknown[]) => Promise<unknown[]>)(...args);
        selected.push(rows);
        return rows;
      });
    real('dbRead');
    real('dbWrite');
    isPlacementEscrowFunded.mockResolvedValue(true);
  });
  const ids = (call = 0) => (selected[call] as { id: number }[]).map((row) => row.id);

  it('the readiness pass selects funded rows whose post is ready, doomed or gone', async () => {
    await startReadyStorylineContinuations();
    // 114 and 115 are decided after the selection, against the storyline.
    expect(ids()).toEqual([101, 102, 108, 109, 113, 114, 115, 116, 122, 123]);
  });

  it('the readiness pass honours its batch limit', async () => {
    await startReadyStorylineContinuations({ limit: 3 });
    expect(ids()).toEqual([101, 102, 108]);
  });

  it("the owner's queue lists admitted rows with a live post, oldest first, in pages", async () => {
    const first = await getPendingStorylineContinuations({
      ownerId: 7,
      domainLevels: 31,
      limit: 2,
    });
    expect(ids()).toEqual([201, 202, 203]);
    expect(first.nextCursor).toEqual(expect.any(String));

    selected = [];
    await getPendingStorylineContinuations({
      ownerId: 7,
      domainLevels: 31,
      limit: 2,
      cursor: first.nextCursor,
    });
    // 203 shares 202's createdAt: the id breaks the tie, so it is neither lost nor repeated.
    expect(ids()).toEqual([203, 209]);
  });

  it('the unfunded sweep selects stale priced rows with no hold leg in flight', async () => {
    await settleStaleUnfundedContinuations();
    expect(ids()).toEqual([301, 306, 308, 311, 312]);
    expect(settlePlacement).not.toHaveBeenCalled();
  });

  // The selection sums receipted hold legs. It can do that only because a second leg of one
  // kind cannot exist, or a retried hold would count twice and fund a row that is short.
  it('a placement cannot hold two legs of one kind', async () => {
    expect(holdKindUnique).toBeDefined();
    await prisma.$executeRawUnsafe(holdKindUnique!);
    await expect(
      prisma.$executeRawUnsafe(leg({ placementId: 311, kind: 'holdFee', amount: 70 }))
    ).rejects.toThrow(/23505[\s\S]*\(311, holdFee\) already exists/);
  });
});
