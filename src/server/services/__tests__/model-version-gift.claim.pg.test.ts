import { readFileSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gift cap under real concurrency. A mock cannot race, so this runs the claim's own SQL
 * (`redeemGiftLink`) against a throwaway Postgres: the migration file itself creates the tables.
 *
 * Needs `APPDATA_TEST_DATABASE_URL`: the unit CI job's superuser URL to a THROWAWAY server, shared with
 * doc-store.pg.test.ts. The suite creates and drops its own database there. Without it every case is
 * skipped, and CI fails instead (below).
 */
const URL_BASE = process.env.APPDATA_TEST_DATABASE_URL;
const DB_NAME = 'model_gift_claim_test';

vi.mock('~/server/services/orchestrator/models', () => ({ bustOrchestratorModelCache: vi.fn() }));
vi.mock('~/server/services/paid-access.service', () => ({ getPaidAccess: vi.fn() }));
const { queryGiftList, redeemGiftLink } = await import(
  '~/server/services/model-version-gift.service'
);

describe.runIf(!!process.env.CI)('CI provides a real Postgres', () => {
  it('APPDATA_TEST_DATABASE_URL is set', () => {
    expect(URL_BASE, 'the unit job must set APPDATA_TEST_DATABASE_URL').toBeTruthy();
  });
});

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20261229120000_model_version_gift_link/migration.sql'
);
// The parts of the real schema the migration and the grant touch.
const PREREQUISITES = `
  CREATE TABLE "User" (id SERIAL PRIMARY KEY);
  CREATE TABLE "ModelVersion" (id SERIAL PRIMARY KEY);
  CREATE TABLE "EntityAccess" (
    "accessToId" INTEGER NOT NULL, "accessToType" TEXT NOT NULL,
    "accessorId" INTEGER NOT NULL, "accessorType" TEXT NOT NULL,
    "addedById" INTEGER NOT NULL, "addedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
    "permissions" INTEGER NOT NULL DEFAULT 0, "meta" JSONB DEFAULT '{}',
    PRIMARY KEY ("accessToId", "accessToType", "accessorId", "accessorType")
  );
`;

const OWNER = 1;
const VERSION = 1;
const USERS = 10;

describe.skipIf(!URL_BASE)('gift claim on Postgres', () => {
  let prisma: PrismaClient;
  let sql: Client;

  beforeAll(async () => {
    const admin = new Client({ connectionString: URL_BASE });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB_NAME}`);
    await admin.end();

    const url = new URL(URL_BASE!);
    url.pathname = `/${DB_NAME}`;
    sql = new Client({ connectionString: url.toString() });
    await sql.connect();
    await sql.query(PREREQUISITES);
    await sql.query(readFileSync(MIGRATION, 'utf8'));
    await sql.query(`INSERT INTO "User" (id) SELECT generate_series(1, ${USERS + 1})`);
    await sql.query(`INSERT INTO "ModelVersion" (id) VALUES (${VERSION})`);

    url.searchParams.set('connection_limit', String(USERS + 2));
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await sql?.end();
  });

  beforeEach(async () => {
    await sql.query(
      `TRUNCATE "ModelVersionGiftRedemption", "ModelVersionGiftLink", "EntityAccess" RESTART IDENTITY CASCADE`
    );
  });

  async function newLink(maxRedemptions: number | null) {
    const { rows } = await sql.query(
      `INSERT INTO "ModelVersionGiftLink" ("modelVersionId", "createdById", "codeHash", "codeHint", "maxRedemptions")
       VALUES ($1, $2, md5(random()::text), 'XXXX', $3) RETURNING id`,
      [VERSION, OWNER, maxRedemptions]
    );
    return rows[0].id as number;
  }

  const claim = (giftLinkId: number, userId: number) =>
    redeemGiftLink(prisma, {
      giftLinkId,
      userId,
      modelVersionId: VERSION,
      permissions: 3,
      addedById: OWNER,
    });

  const count = async (q: string) => Number((await sql.query(q)).rows[0].n);

  it(`grants exactly the cap when ${USERS} users claim a 3-claim link at once`, async () => {
    const id = await newLink(3);
    const outcomes = await Promise.all(Array.from({ length: USERS }, (_, i) => claim(id, i + 2)));

    expect(outcomes.filter((o) => o === 'granted')).toHaveLength(3);
    expect(outcomes.filter((o) => o === 'unavailable')).toHaveLength(USERS - 3);
    expect(
      await count(`SELECT "redemptionCount" AS n FROM "ModelVersionGiftLink" WHERE id = ${id}`)
    ).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM "ModelVersionGiftRedemption"`)).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM "EntityAccess"`)).toBe(3);
  });

  it('counts one user claiming the same link five times at once as one redemption', async () => {
    const id = await newLink(null);
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => claim(id, 2)));

    expect(outcomes.filter((o) => o === 'granted')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'already-claimed')).toHaveLength(4);
    expect(
      await count(`SELECT "redemptionCount" AS n FROM "ModelVersionGiftLink" WHERE id = ${id}`)
    ).toBe(1);
  });

  it('refuses a revoked link and leaves no grant behind', async () => {
    const id = await newLink(null);
    await sql.query(`UPDATE "ModelVersionGiftLink" SET "revokedAt" = now() WHERE id = ${id}`);

    expect(await claim(id, 2)).toBe('unavailable');
    expect(await count(`SELECT count(*) AS n FROM "ModelVersionGiftRedemption"`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM "EntityAccess"`)).toBe(0);
  });

  it('merges into a buyer’s row without dropping the purchase transaction id', async () => {
    await sql.query(
      `INSERT INTO "EntityAccess" ("accessToId", "accessToType", "accessorId", "accessorType", "addedById", "permissions", "meta")
       VALUES (${VERSION}, 'ModelVersion', 2, 'User', 2, 1, '{"generation-buzzTransactionId": "tx-1"}')`
    );
    const id = await newLink(null);

    expect(await claim(id, 2)).toBe('granted');
    const { rows } = await sql.query(
      `SELECT permissions, meta FROM "EntityAccess" WHERE "accessorId" = 2`
    );
    expect(rows[0]).toEqual({
      permissions: 3,
      meta: { 'generation-buzzTransactionId': 'tx-1', giftLinkId: id },
    });
  });

  it('summarises a batch: claimed, still live, and spent codes', async () => {
    await sql.query(
      `INSERT INTO "ModelVersionGiftLink"
         ("modelVersionId", "createdById", "codeHash", "codeHint", "batchId", "maxRedemptions",
          "redemptionCount", "revokedAt", "expiresAt")
       VALUES
         ($1, $2, 'h1', 'A', 'b1', 1, 1, NULL, NULL),
         ($1, $2, 'h2', 'B', 'b1', 1, 0, now(), NULL),
         ($1, $2, 'h3', 'C', 'b1', 1, 0, NULL, now() - interval '1 day'),
         ($1, $2, 'h4', 'D', 'b1', 1, 0, NULL, NULL),
         ($1, $2, 'h5', 'E', NULL, 2, 2, NULL, NULL),
         ($1, $2, 'h6', 'F', NULL, NULL, 5, NULL, NULL)`,
      [VERSION, OWNER]
    );

    // E is the newer link, so only the live-first ordering can put F ahead of it.
    await sql.query(
      `UPDATE "ModelVersionGiftLink" SET "createdAt" = now() - interval '1 hour' WHERE "codeHint" = 'F'`
    );

    const { links, batches } = await queryGiftList(prisma, VERSION);

    expect(batches).toEqual([
      expect.objectContaining({ batchId: 'b1', total: 4, claimed: 1, live: 1 }),
    ]);
    // Live first: the uncapped link, then the one at its cap.
    expect(links.map((l) => [l.codeHint, l.live])).toEqual([
      ['F', true],
      ['E', false],
    ]);
  });
});
