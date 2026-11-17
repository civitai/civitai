import { readFileSync } from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import type { NextApiRequest } from 'next';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { SessionUser } from '~/types/session';

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
const { getFeatureFlagsAsync } = vi.hoisted(() => ({ getFeatureFlagsAsync: vi.fn() }));
vi.mock('~/server/services/feature-flags.service', () => ({ getFeatureFlagsAsync }));
vi.mock('~/server/services/paid-access.service', () => ({ getPaidAccess: vi.fn() }));
const { insertWithinLiveCap, queryGiftList, redeemGiftLink, revokeGiftRedemption } = await import(
  '~/server/services/model-version-gift.service'
);
const { GIFT_CLAIM_LOCK_CLASS, GIFT_LIVE_CODES_MAX_PER_VERSION: CAP } = await import(
  '~/server/services/model-version-gift.constants'
);
const { grantModelVersionAccess } = await import('~/server/services/model-version-access.service');
const { usageLimitCounters } = await import('~/server/services/usage-limit-counters');

describe.runIf(!!process.env.CI)('CI provides a real Postgres', () => {
  it('APPDATA_TEST_DATABASE_URL is set', () => {
    expect(URL_BASE, 'the unit job must set APPDATA_TEST_DATABASE_URL').toBeTruthy();
  });
});

const MIGRATIONS = [
  '20261229120000_model_version_gift_link',
  '20261231000100_model_version_gift_redemption_revoked',
].map((dir) =>
  path.resolve(
    __dirname,
    `../../../../packages/civitai-db-schema/prisma/migrations/${dir}/migration.sql`
  )
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
    for (const file of MIGRATIONS) await sql.query(readFileSync(file, 'utf8'));
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
      addedById: userId,
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

    expect(outcomes).toEqual(Array(5).fill('granted'));
    expect(
      await count(`SELECT "redemptionCount" AS n FROM "ModelVersionGiftLink" WHERE id = ${id}`)
    ).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM "ModelVersionGiftRedemption"`)).toBe(1);
  });

  it('re-grants a claimer whose grant was removed, without taking another slot', async () => {
    const id = await newLink(1);
    expect(await claim(id, 2)).toBe('granted');
    // What the early-access refund does on unpublish.
    await sql.query(`DELETE FROM "EntityAccess"`);

    expect(await claim(id, 2)).toBe('granted');
    expect(await count(`SELECT count(*) AS n FROM "EntityAccess"`)).toBe(1);
    expect(
      await count(`SELECT "redemptionCount" AS n FROM "ModelVersionGiftLink" WHERE id = ${id}`)
    ).toBe(1);
  });

  it('does not re-grant from a link that has expired since the first claim', async () => {
    const id = await newLink(null);
    expect(await claim(id, 2)).toBe('granted');
    await sql.query(`DELETE FROM "EntityAccess"`);
    await sql.query(
      `UPDATE "ModelVersionGiftLink" SET "expiresAt" = now() - interval '1 minute' WHERE id = ${id}`
    );

    expect(await claim(id, 2)).toBe('unavailable');
    expect(await count(`SELECT count(*) AS n FROM "EntityAccess"`)).toBe(0);
  });

  it('does not re-grant from a link revoked since the first claim', async () => {
    const id = await newLink(null);
    expect(await claim(id, 2)).toBe('granted');
    await sql.query(`DELETE FROM "EntityAccess"`);
    await sql.query(`UPDATE "ModelVersionGiftLink" SET "revokedAt" = now() WHERE id = ${id}`);

    expect(await claim(id, 2)).toBe('unavailable');
    expect(await count(`SELECT count(*) AS n FROM "EntityAccess"`)).toBe(0);
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
      meta: { 'generation-buzzTransactionId': 'tx-1', giftLinkId: id, 'gift-permissions': 3 },
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

  it('refuses an expired link and leaves no grant behind', async () => {
    const id = await newLink(null);
    await sql.query(
      `UPDATE "ModelVersionGiftLink" SET "expiresAt" = now() - interval '1 minute' WHERE id = ${id}`
    );

    expect(await claim(id, 2)).toBe('unavailable');
    expect(await count(`SELECT count(*) AS n FROM "EntityAccess"`)).toBe(0);
  });

  it('starts the refund window at the first purchase on a row a gift created', async () => {
    const id = await newLink(null);
    expect(await claim(id, 2)).toBe('granted');
    await sql.query(`UPDATE "EntityAccess" SET "addedAt" = now() - interval '30 days'`);

    const purchase = (key: string, tx: string) =>
      grantModelVersionAccess({
        client: prisma,
        userId: 2,
        modelVersionId: VERSION,
        permissions: 3,
        meta: { [key]: tx },
        addedById: 2,
      });
    const ageDays = async () =>
      count(`SELECT extract(day FROM now() - "addedAt")::int AS n FROM "EntityAccess"`);

    await purchase('generation-buzzTransactionId', 'tx-1');
    expect(await ageDays()).toBe(0);

    // A later purchase on a row that already holds one keeps the first purchase's start.
    await sql.query(`UPDATE "EntityAccess" SET "addedAt" = now() - interval '10 days'`);
    await purchase('download-buzzTransactionId', 'tx-2');
    expect(await ageDays()).toBe(10);
  });

  it('lets only one of two concurrent mints take the last slot under the live cap', async () => {
    await sql.query(
      `INSERT INTO "ModelVersionGiftLink" ("modelVersionId", "createdById", "codeHash", "codeHint", "maxRedemptions")
       SELECT $1, $2, md5(g::text), 'XXXX', 1 FROM generate_series(1, $3) g`,
      [VERSION, OWNER, CAP - 1]
    );
    // Each insert waits, so without the lock the second mint counts while the first is uncommitted.
    const mint = () =>
      insertWithinLiveCap(prisma, VERSION, 1, async (tx) => {
        await new Promise((r) => setTimeout(r, 300));
        await tx.$executeRaw`
          INSERT INTO "ModelVersionGiftLink" ("modelVersionId", "createdById", "codeHash", "codeHint", "maxRedemptions")
          VALUES (${VERSION}, ${OWNER}, md5(random()::text), 'YYYY', 1)`;
      });

    const outcomes = await Promise.allSettled([mint(), mint()]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toContain(`at most ${CAP} live gift codes`);
    expect(await count(`SELECT count(*) AS n FROM "ModelVersionGiftLink"`)).toBe(CAP);
  });

  // Connections opened by a test, closed even when it fails.
  const extra: Client[] = [];
  afterEach(async () => {
    // Ending them first rolls back their open transactions, which the DROP would wait on.
    for (const client of extra.splice(0)) await client.end().catch(() => undefined);
    await sql.query(`DROP TRIGGER IF EXISTS gate ON "EntityAccess"`);
  });

  async function connect() {
    const url = new URL(URL_BASE!);
    url.pathname = `/${DB_NAME}`;
    const client = new Client({ connectionString: url.toString() });
    extra.push(client);
    await client.connect();
    return client;
  }

  /** A second connection holding a transaction open, so the code under test meets it mid-flight. */
  async function openTransaction(statements: string[]) {
    const other = await connect();
    await other.query('BEGIN');
    for (const statement of statements) await other.query(statement);
    return { commit: () => other.query('COMMIT') };
  }

  /** Resolves once `n` sessions on the test database wait on a lock, or `done()` says to stop. */
  async function lockWaiters(n: number, done = () => false) {
    for (let i = 0; i < 500 && !done(); i++) {
      const waiting = await count(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = '${DB_NAME}' AND wait_event_type = 'Lock'`
      );
      if (waiting >= n) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!done()) throw new Error(`fewer than ${n} sessions ever waited on a lock`);
  }

  describe('removing one claim', () => {
    const CLAIMER = 2;
    const remove = (giftLinkId: number, modelVersionId = VERSION) =>
      revokeGiftRedemption(prisma, {
        giftLinkId,
        claimerId: CLAIMER,
        modelVersionId,
        revokedById: OWNER,
        visibleSince: new Date('2020-01-01T00:00:00.000Z'),
      });
    const access = async () =>
      (
        await sql.query(
          `SELECT permissions, meta FROM "EntityAccess" WHERE "accessorId" = ${CLAIMER}`
        )
      ).rows[0] ?? null;
    const buy = (meta: object, permissions: number) =>
      sql.query(
        `INSERT INTO "EntityAccess" ("accessToId", "accessToType", "accessorId", "accessorType", "addedById", "permissions", "meta")
         VALUES ($1, 'ModelVersion', $2, 'User', $2, $3, $4)`,
        [VERSION, CLAIMER, permissions, JSON.stringify(meta)]
      );

    it('takes back a gift-only grant, marks the claim, and keeps its slot spent', async () => {
      const id = await newLink(1);
      expect(await claim(id, CLAIMER)).toBe('granted');

      expect(await remove(id)).toEqual({ accessKept: false });
      expect(await access()).toBeNull();
      const { rows } = await sql.query(
        `SELECT "revokedAt" IS NOT NULL AS revoked, "revokedById" FROM "ModelVersionGiftRedemption"`
      );
      expect(rows).toEqual([{ revoked: true, revokedById: OWNER }]);
      expect(
        await count(`SELECT "redemptionCount" AS n FROM "ModelVersionGiftLink" WHERE id = ${id}`)
      ).toBe(1);
    });

    it('leaves what a purchase pays for, and drops only the gift keys', async () => {
      await buy({ 'generation-buzzTransactionId': 'tx-1' }, 1);
      const id = await newLink(null);
      expect(await claim(id, CLAIMER)).toBe('granted');

      await remove(id);
      expect(await access()).toEqual({
        permissions: 1,
        meta: { 'generation-buzzTransactionId': 'tx-1' },
      });
    });

    it('keeps bits a purchase also pays for', async () => {
      await buy({ 'download-buzzTransactionId': 'tx-1' }, 3);
      const id = await newLink(null);
      expect(await claim(id, CLAIMER)).toBe('granted');

      await remove(id);
      expect(await access()).toEqual({
        permissions: 3,
        meta: { 'download-buzzTransactionId': 'tx-1' },
      });
    });

    it('keeps access while another claim on the version stands', async () => {
      const a = await newLink(null);
      const b = await newLink(null);
      expect(await claim(a, CLAIMER)).toBe('granted');
      // The second claim records itself even though the access is already held.
      expect(await claim(b, CLAIMER)).toBe('granted');

      expect(await remove(a)).toEqual({ accessKept: true });
      expect((await access())?.permissions).toBe(3);
      expect(await remove(b)).toEqual({ accessKept: false });
      expect(await access()).toBeNull();
    });

    it('refuses a re-claim of the removed claim, but not a claim on another link', async () => {
      const a = await newLink(null);
      const b = await newLink(null);
      expect(await claim(a, CLAIMER)).toBe('granted');
      await remove(a);

      expect(await claim(a, CLAIMER)).toBe('unavailable');
      expect(await access()).toBeNull();
      expect(await claim(b, CLAIMER)).toBe('granted');
      expect((await access())?.permissions).toBe(3);
    });

    it('refuses a claim already removed, one on another version, and one before visibleSince', async () => {
      const id = await newLink(null);
      expect(await claim(id, CLAIMER)).toBe('granted');

      await expect(remove(id, VERSION + 1)).rejects.toThrow('No claim to remove.');
      await expect(
        revokeGiftRedemption(prisma, {
          giftLinkId: id,
          claimerId: CLAIMER,
          modelVersionId: VERSION,
          revokedById: OWNER,
          visibleSince: new Date(Date.now() + 60_000),
        })
      ).rejects.toThrow('No claim to remove.');
      expect((await access())?.permissions).toBe(3);

      await remove(id);
      await expect(remove(id)).rejects.toThrow('No claim to remove.');
    });

    it('marks the claim when the grant row is already gone', async () => {
      const id = await newLink(null);
      expect(await claim(id, CLAIMER)).toBe('granted');
      // What the early-access refund does on unpublish.
      await sql.query(`DELETE FROM "EntityAccess"`);

      expect(await remove(id)).toEqual({ accessKept: false });
      expect(
        await count(
          `SELECT count(*) AS n FROM "ModelVersionGiftRedemption" WHERE "revokedAt" IS NOT NULL`
        )
      ).toBe(1);
    });

    it('clears every bit of a gift row that never recorded its bits', async () => {
      const id = await newLink(null);
      expect(await claim(id, CLAIMER)).toBe('granted');
      await sql.query(`UPDATE "EntityAccess" SET meta = meta - 'gift-permissions'`);

      await remove(id);
      expect(await access()).toBeNull();
    });

    it('removes a claim made at the visibleSince moment', async () => {
      const id = await newLink(null);
      expect(await claim(id, CLAIMER)).toBe('granted');
      const { rows } = await sql.query(`SELECT "claimedAt" FROM "ModelVersionGiftRedemption"`);

      await revokeGiftRedemption(prisma, {
        giftLinkId: id,
        claimerId: CLAIMER,
        modelVersionId: VERSION,
        revokedById: OWNER,
        visibleSince: rows[0].claimedAt,
      });
      expect(await access()).toBeNull();
    });

    it('refuses a repeat claim that meets a removal in flight', async () => {
      const id = await newLink(null);
      expect(await claim(id, CLAIMER)).toBe('granted');
      const removal = await openTransaction([
        `UPDATE "ModelVersionGiftRedemption" SET "revokedAt" = now() WHERE "giftLinkId" = ${id}`,
        `DELETE FROM "EntityAccess"`,
      ]);

      const repeat = claim(id, CLAIMER);
      await lockWaiters(1);
      await removal.commit();

      expect(await repeat).toBe('unavailable');
      expect(await access()).toBeNull();
    });

    it('makes a removal wait for a repeat claim already granting', async () => {
      const id = await newLink(null);
      expect(await claim(id, CLAIMER)).toBe('granted');
      await sql.query(`DELETE FROM "EntityAccess"`);
      // Holds every grant write at a gate this test opens, so the claim stops after its checks.
      await sql.query(`
        CREATE OR REPLACE FUNCTION gate() RETURNS trigger AS $$
        BEGIN PERFORM pg_advisory_xact_lock(42); RETURN NEW; END $$ LANGUAGE plpgsql;
        CREATE TRIGGER gate BEFORE INSERT OR UPDATE ON "EntityAccess"
          FOR EACH ROW EXECUTE FUNCTION gate();
      `);
      const gate = await connect();
      await gate.query('SELECT pg_advisory_lock(42)');

      const repeat = claim(id, CLAIMER);
      await lockWaiters(1);
      let removed = false;
      const removal = remove(id).finally(() => (removed = true));
      // The removal either waits behind the claim, or (wrongly) finishes before the claim grants.
      await lockWaiters(2, () => removed);
      await gate.query('SELECT pg_advisory_unlock(42)');

      expect(await repeat).toBe('granted');
      expect(await removal).toEqual({ accessKept: false });
      expect(await access()).toBeNull();
    });

    it('keeps the access a claim on another link grants while the removal runs', async () => {
      const a = await newLink(null);
      const b = await newLink(null);
      expect(await claim(a, CLAIMER)).toBe('granted');
      // Link b's claim, recorded and holding the grant row, not yet committed.
      const otherClaim = await openTransaction([
        `INSERT INTO "ModelVersionGiftRedemption" ("giftLinkId", "userId") VALUES (${b}, ${CLAIMER})`,
        `UPDATE "EntityAccess" SET meta = meta || '{"giftLinkId": ${b}}'`,
      ]);

      const removal = remove(a);
      await lockWaiters(1);
      await otherClaim.commit();

      expect(await removal).toEqual({ accessKept: true });
      expect((await access())?.permissions).toBe(3);
    });
  });

  describe('monthly claim allowance', () => {
    const CLAIMER = 2;
    // This UTC month: claims made by the test itself are recorded at now().
    const today = new Date();
    const START = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const END = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
    /** `ms` after the start of this month, as a timestamp(3) literal. */
    const at = (ms: number) =>
      new Date(START.getTime() + ms).toISOString().replace('T', ' ').replace('Z', '');
    const DAY_MS = 24 * 60 * 60 * 1000;
    const claimWithin = (giftLinkId: number, limit: number, userId = CLAIMER) =>
      redeemGiftLink(prisma, {
        giftLinkId,
        userId,
        modelVersionId: VERSION,
        permissions: 3,
        addedById: userId,
        allowance: { limit, start: START, end: END },
      });
    /** A claim recorded at `claimedAt`, as if made then. */
    async function pastClaim(claimedAt: string, revoked = false) {
      const id = await newLink(null);
      await sql.query(
        `INSERT INTO "ModelVersionGiftRedemption" ("giftLinkId", "userId", "claimedAt", "revokedAt")
         VALUES ($1, $2, $3, $4)`,
        [id, CLAIMER, claimedAt, revoked ? claimedAt : null]
      );
      return id;
    }
    const redemptions = () =>
      count(`SELECT count(*) AS n FROM "ModelVersionGiftRedemption" WHERE "userId" = ${CLAIMER}`);

    it('refuses the claim past the limit and takes no slot or grant for it', async () => {
      await pastClaim(at(DAY_MS));
      await pastClaim(at(2 * DAY_MS));
      const id = await newLink(5);

      await expect(claimWithin(id, 2)).rejects.toMatchObject({ used: 2 });
      expect(
        await count(`SELECT "redemptionCount" AS n FROM "ModelVersionGiftLink" WHERE id = ${id}`)
      ).toBe(0);
      expect(await redemptions()).toBe(2);
      expect(await count(`SELECT count(*) AS n FROM "EntityAccess"`)).toBe(0);
    });

    it('counts only claims in [start, end), removed ones included', async () => {
      await pastClaim(at(-1));
      await pastClaim(at(END.getTime() - START.getTime()));
      await pastClaim(at(0), true);

      expect(await claimWithin(await newLink(null), 2)).toBe('granted');
      await expect(claimWithin(await newLink(null), 2)).rejects.toMatchObject({ used: 2 });
    });

    it('reports on /me/limits the same count the claim enforces', async () => {
      await pastClaim(at(-1));
      await pastClaim(at(END.getTime() - START.getTime()));
      await pastClaim(at(0), true);
      await pastClaim(at(DAY_MS));
      await sql.query(
        `INSERT INTO "ModelVersionGiftRedemption" ("giftLinkId", "userId", "claimedAt") VALUES ($1, 3, $2)`,
        [await newLink(null), at(DAY_MS)]
      );

      // The `/me/limits` counter reads through dbRead: point it at the throwaway database.
      vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(
        (...args: Parameters<typeof prisma.$queryRaw>) => prisma.$queryRaw(...args)
      );
      getFeatureFlagsAsync.mockResolvedValue({ modelGiftLinks: true });
      const counter = usageLimitCounters['gifts.monthly']!;
      const args = { user: { id: CLAIMER } as SessionUser, req: {} as NextApiRequest };
      expect(await counter({ ...args, start: START, end: END })).toBe(2);

      // No row for a user the gift feature is not released to.
      getFeatureFlagsAsync.mockResolvedValue({ modelGiftLinks: false });
      expect(await counter({ ...args, start: START, end: END })).toBeNull();
    });

    it('lets a repeat claim of the same link through, even past a since-lowered limit', async () => {
      await pastClaim(at(DAY_MS));
      const id = await newLink(null);
      expect(await claimWithin(id, 2)).toBe('granted');
      await sql.query(`DELETE FROM "EntityAccess"`);

      expect(await claimWithin(id, 1)).toBe('granted');
      expect(await redemptions()).toBe(2);
    });

    it(`grants exactly the limit when ${USERS} claims by one user on different links race`, async () => {
      const ids = await Promise.all(Array.from({ length: USERS }, () => newLink(null)));
      const outcomes = await Promise.allSettled(ids.map((id) => claimWithin(id, 3)));

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(3);
      expect(await redemptions()).toBe(3);
    });

    it('makes a new claim wait for one in flight, then count it', async () => {
      await pastClaim(at(DAY_MS));
      const other = await newLink(null);
      // Another new claim by the same user: holding the allowance lock, recorded, not committed.
      const inFlight = await openTransaction([
        `INSERT INTO "ModelVersionGiftRedemption" ("giftLinkId", "userId") VALUES (${other}, ${CLAIMER})`,
        `SELECT pg_advisory_xact_lock(${GIFT_CLAIM_LOCK_CLASS}, ${CLAIMER})`,
      ]);

      let settled = false;
      const attempt = claimWithin(await newLink(null), 2).finally(() => (settled = true));
      await lockWaiters(1, () => settled);
      await inFlight.commit();

      await expect(attempt).rejects.toMatchObject({ used: 2 });
    });
  });
});
