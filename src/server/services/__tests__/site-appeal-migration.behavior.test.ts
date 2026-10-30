import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The site appeal form's migrations, APPLIED in order to a real Postgres on top of the Appeal
 * indexes main has today. The one-Pending rules live only in partial unique indexes, which no
 * Prisma fake restates, so this is the only place they are exercised.
 */

const MIGRATIONS_DIR = path.join(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const read = (name: string) =>
  readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');

const PRE_EXISTING = '20261002200000_appeal_one_pending_per_entity';
const SITE_APPEAL_MIGRATIONS = [
  '20261102120000_appeal_category',
  '20261102120100_appeal_inapp_pending_key',
  '20261102120200_appeal_category_pending_key',
  '20261102120300_appeal_category_queue_idx',
  '20261102120400_appeal_drop_old_pending_key',
];

let db: PGlite;

async function insert(row: {
  entityType: string;
  entityId: number;
  userId: number;
  status?: string;
  category?: string | null;
}) {
  await db.query(
    `INSERT INTO "Appeal" ("userId", "entityType", "entityId", status, category, "appealMessage", "updatedAt")
     VALUES ($1, $2::"EntityType", $3, $4::"AppealStatus", $5::"AppealCategory", 'm', now())`,
    [row.userId, row.entityType, row.entityId, row.status ?? 'Pending', row.category ?? null]
  );
}

async function rejects(row: Parameters<typeof insert>[0]) {
  return insert(row).then(
    () => 'inserted',
    (e: { code?: string }) => e.code
  );
}

beforeEach(async () => {
  db = new PGlite();
  // The table as `20241204163054_appeal_model` left it, minus the User FKs.
  await db.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Model', 'Article', 'User');
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TABLE "Appeal" (
      id SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL,
      "entityType" "EntityType" NOT NULL,
      "entityId" INTEGER NOT NULL,
      status "AppealStatus" NOT NULL DEFAULT 'Pending',
      "appealMessage" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL
    );
    CREATE UNIQUE INDEX "Appeal_entityType_entityId_userId_key" ON "Appeal"("entityType", "entityId", "userId");
  `);
  await db.exec(read(PRE_EXISTING));
  // One statement per file for the CONCURRENTLY ones, so each runs outside a transaction block
  // exactly as it must in production.
  for (const name of SITE_APPEAL_MIGRATIONS) await db.exec(read(name));
});

describe('site appeal migrations', () => {
  it('leave exactly the two category-aware pending keys and the queue index', async () => {
    const { rows } = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Appeal' ORDER BY indexname`
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      'Appeal_category_pending_key',
      'Appeal_category_status_createdAt_idx',
      'Appeal_entityType_entityId_userId_idx',
      'Appeal_inapp_pending_key',
      'Appeal_pkey',
    ]);
  });

  it('build the queue index over form appeals only', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'Appeal_category_status_createdAt_idx'`
    );
    expect(rows[0].indexdef).toMatch(
      /\(category, status, "createdAt", id\) WHERE \(category IS NOT NULL\)$/
    );
  });

  it('key form appeals per appellant, not per entity alone', async () => {
    await insert({ entityType: 'Model', entityId: 1, userId: 7, category: 'Model' });
    expect(await rejects({ entityType: 'Model', entityId: 1, userId: 8, category: 'Model' })).toBe(
      'inserted'
    );
  });

  it('still refuse a second Pending in-app appeal on one entity', async () => {
    await insert({ entityType: 'Model', entityId: 1, userId: 7 });
    expect(await rejects({ entityType: 'Model', entityId: 1, userId: 7 })).toBe('23505');
  });

  it('refuse a second Pending form appeal in the same category on one entity', async () => {
    await insert({ entityType: 'User', entityId: 7, userId: 7, category: 'Account' });
    expect(await rejects({ entityType: 'User', entityId: 7, userId: 7, category: 'Account' })).toBe(
      '23505'
    );
  });

  it('let a form appeal and an in-app appeal on the same entity both be Pending', async () => {
    await insert({ entityType: 'Model', entityId: 1, userId: 7 });
    expect(await rejects({ entityType: 'Model', entityId: 1, userId: 7, category: 'Model' })).toBe(
      'inserted'
    );
  });

  it('let an Account and an Other appeal, both on the appellant, be Pending together', async () => {
    await insert({ entityType: 'User', entityId: 7, userId: 7, category: 'Account' });
    expect(await rejects({ entityType: 'User', entityId: 7, userId: 7, category: 'Other' })).toBe(
      'inserted'
    );
  });

  it('allow a new form appeal once the earlier one is decided', async () => {
    await insert({
      entityType: 'User',
      entityId: 7,
      userId: 7,
      category: 'Account',
      status: 'Rejected',
    });
    expect(await rejects({ entityType: 'User', entityId: 7, userId: 7, category: 'Account' })).toBe(
      'inserted'
    );
  });
});
