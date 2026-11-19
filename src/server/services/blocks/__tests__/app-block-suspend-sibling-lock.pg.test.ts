import { PrismaClient, type Prisma } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  lockAppBlockClientRows,
  revokeAppBlockOauthTokens,
} from '~/server/services/blocks/app-block-token-revoke.service';

/**
 * Two suspensions of one client's blocks at once, on a real Postgres: each counts the other block's
 * status, and a mock cannot race. Needs `APPDATA_TEST_DATABASE_URL` (the unit CI job's throwaway
 * server, shared with doc-store.pg.test.ts); the suite makes and drops its own database there.
 */
const URL_BASE = process.env.APPDATA_TEST_DATABASE_URL;
const DB_NAME = `app_block_suspend_lock_${process.pid}`;
const CLIENT = 'appblk-sibling-lock';

describe.runIf(!!process.env.CI)('CI provides a real Postgres', () => {
  it('APPDATA_TEST_DATABASE_URL is set', () => {
    expect(URL_BASE, 'the unit job must set APPDATA_TEST_DATABASE_URL').toBeTruthy();
  });
});

const SCHEMA = `
  CREATE TYPE "ApiKeyType" AS ENUM ('System', 'User', 'Access', 'Refresh', 'Worker');
  CREATE TABLE app_blocks (
    id TEXT PRIMARY KEY, app_id TEXT NOT NULL, status TEXT NOT NULL,
    updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
  );
  CREATE TABLE "ApiKey" (
    id SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, type "ApiKeyType" NOT NULL, "clientId" TEXT
  );
`;

/**
 * The first suspension to finish its flip waits here until the second one either blocks on a row
 * lock (what the lock is for) or reaches its own flip too (the race), and reports which.
 */
function firstFlipWatch(sql: () => Client) {
  let arrived = 0;
  let sawLockWait: boolean | null = null;
  return {
    get sawLockWait() {
      return sawLockWait;
    },
    async afterFlip() {
      if (++arrived > 1) return;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && arrived < 2) {
        const { rows } = await sql().query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`,
          [DB_NAME]
        );
        if (rows.length) {
          sawLockWait = true;
          return;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      sawLockWait = false;
    },
  };
}

describe.skipIf(!URL_BASE)('suspending two blocks of one client at once', () => {
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
    await sql.query(SCHEMA);
    url.searchParams.set('connection_limit', '4');
    prisma = new PrismaClient({ datasourceUrl: url.toString() });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await sql?.end();
    const admin = new Client({ connectionString: URL_BASE });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await admin.end();
  });

  beforeEach(async () => {
    await sql.query('TRUNCATE app_blocks, "ApiKey"');
    await sql.query(
      `INSERT INTO app_blocks (id, app_id, status) VALUES ('blk_a', $1, 'approved'), ('blk_b', $1, 'approved')`,
      [CLIENT]
    );
    await sql.query(`INSERT INTO "ApiKey" ("userId", type, "clientId") VALUES (7, 'Access', $1)`, [
      CLIENT,
    ]);
  });

  const liveTokens = async () =>
    Number(
      (await sql.query('SELECT count(*) FROM "ApiKey" WHERE "clientId" = $1', [CLIENT])).rows[0]
        .count
    );

  /** A suspending writer's order: lock, flip, then revoke, all in one transaction. */
  const suspend = (id: string, afterFlip: () => Promise<void>) =>
    prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockAppBlockClientRows(tx, id);
      await tx.appBlock.updateMany({ where: { id }, data: { status: 'suspended' } });
      await afterFlip();
      return revokeAppBlockOauthTokens(tx, id);
    });

  it('the second suspension counts the first, so the client loses its token', async () => {
    // Without the lock both flips land before either count, and each sees the other approved.
    const watch = firstFlipWatch(() => sql);
    const results = await Promise.allSettled([
      suspend('blk_a', () => watch.afterFlip()),
      suspend('blk_b', () => watch.afterFlip()),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(watch.sawLockWait).toBe(true);
    expect(await liveTokens()).toBe(0);
    const statuses = await sql.query('SELECT status FROM app_blocks ORDER BY id');
    expect(statuses.rows.map((r) => r.status)).toEqual(['suspended', 'suspended']);
  });

  it('a client with its other block still approved keeps its token', async () => {
    await expect(suspend('blk_a', async () => undefined)).resolves.toBeNull();
    expect(await liveTokens()).toBe(1);
  });
});
