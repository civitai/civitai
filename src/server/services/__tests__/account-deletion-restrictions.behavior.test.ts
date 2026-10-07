import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  closeRestrictionsOfDeletedAccount,
  reopenRestrictionsOfRestoredAccount,
} from '~/server/services/user-restriction.service';

/**
 * Runs both statements, and the migration that adds their status, against an in-process Postgres:
 * which rows move is decided entirely in the WHERE clauses, where a mocked query cannot see it.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const ADD_ACCOUNT_DELETED = readFileSync(
  path.join(MIGRATIONS, '20261010120000_user_restriction_account_deleted/migration.sql'),
  'utf8'
);

const DELETED = 1;
const BYSTANDER = 2;

let db: PGlite;

type Row = {
  id: number;
  status: string;
  resolvedAt: Date | null;
  resolvedBy: number | null;
  resolvedMessage: string | null;
};
const rows = async (userId: number) =>
  (
    await db.query<Row>(
      `SELECT id, status::text AS status, "resolvedAt", "resolvedBy", "resolvedMessage"
       FROM "UserRestriction" WHERE "userId" = $1 ORDER BY id`,
      [userId]
    )
  ).rows;
const statuses = async (userId: number) =>
  Object.fromEntries((await rows(userId)).map((r) => [r.id, r.status]));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "UserRestrictionStatus" AS ENUM ('Pending', 'Upheld', 'Overturned');
    ${ADD_ACCOUNT_DELETED}
    CREATE TABLE "UserRestriction" (
      id int PRIMARY KEY, "userId" int NOT NULL, type text NOT NULL DEFAULT 'generation',
      status "UserRestrictionStatus" NOT NULL DEFAULT 'Pending',
      "resolvedAt" timestamp, "resolvedBy" int, "resolvedMessage" text,
      "updatedAt" timestamp NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX "UserRestriction_scam_pending_key" ON "UserRestriction" ("userId")
      WHERE type = 'scam' AND status = 'Pending';
  `);
});

beforeEach(async () => {
  await db.exec(`TRUNCATE "UserRestriction";`);
  dbMock.dbWrite.$executeRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      const result = await db.query(sql.text, sql.values as unknown[]);
      return result.affectedRows ?? 0;
    }
  );
});

describe('closeRestrictionsOfDeletedAccount', () => {
  it("closes every Pending case of the account, of every type, and nothing it doesn't own", async () => {
    await db.exec(`
      INSERT INTO "UserRestriction" (id, "userId", type, status, "resolvedBy") VALUES
        (1, ${DELETED}, 'generation', 'Pending', NULL),
        (2, ${DELETED}, 'scam', 'Pending', NULL),
        (3, ${DELETED}, 'bot-account', 'Pending', NULL),
        (4, ${DELETED}, 'generation', 'Upheld', 99),
        (5, ${DELETED}, 'generation', 'Overturned', 99),
        (6, ${BYSTANDER}, 'generation', 'Pending', NULL);
    `);

    expect(await closeRestrictionsOfDeletedAccount(DELETED)).toBe(3);

    expect(await statuses(DELETED)).toEqual({
      1: 'AccountDeleted',
      2: 'AccountDeleted',
      3: 'AccountDeleted',
      4: 'Upheld',
      5: 'Overturned',
    });
    expect(await statuses(BYSTANDER)).toEqual({ 6: 'Pending' });
  });

  it('records no moderator: it is not a ruling', async () => {
    await db.exec(`INSERT INTO "UserRestriction" (id, "userId") VALUES (1, ${DELETED});`);

    await closeRestrictionsOfDeletedAccount(DELETED);

    const [row] = await rows(DELETED);
    expect(row.resolvedBy).toBeNull();
    expect(row.resolvedAt).not.toBeNull();
    expect(row.resolvedMessage).toBe('Closed automatically: the account was deleted.');
  });
});

describe('reopenRestrictionsOfRestoredAccount', () => {
  it('puts closed cases back to Pending and leaves rulings alone', async () => {
    await db.exec(`
      INSERT INTO "UserRestriction" (id, "userId", type, status, "resolvedBy") VALUES
        (1, ${DELETED}, 'generation', 'Pending', NULL),
        (2, ${DELETED}, 'generation', 'Upheld', 99),
        (3, ${BYSTANDER}, 'generation', 'Pending', NULL);
    `);
    await closeRestrictionsOfDeletedAccount(DELETED);
    await closeRestrictionsOfDeletedAccount(BYSTANDER);

    await reopenRestrictionsOfRestoredAccount(DELETED);

    expect(await rows(DELETED)).toEqual([
      { id: 1, status: 'Pending', resolvedAt: null, resolvedBy: null, resolvedMessage: null },
      expect.objectContaining({ id: 2, status: 'Upheld', resolvedBy: 99 }),
    ]);
    expect(await statuses(BYSTANDER)).toEqual({ 3: 'AccountDeleted' });
  });

  // Two closed scam cases come from delete, restore with a case filed meanwhile, delete again.
  // Reopening both would violate the one-Pending-scam-case index and fail the whole restore.
  it('reopens only the newest closed scam case', async () => {
    await db.exec(`
      INSERT INTO "UserRestriction" (id, "userId", type, status) VALUES
        (1, ${DELETED}, 'scam', 'AccountDeleted'),
        (2, ${DELETED}, 'scam', 'AccountDeleted'),
        (3, ${DELETED}, 'generation', 'AccountDeleted');
    `);

    await reopenRestrictionsOfRestoredAccount(DELETED);

    expect(await statuses(DELETED)).toEqual({ 1: 'AccountDeleted', 2: 'Pending', 3: 'Pending' });
  });

  it('reopens no scam case while one is already Pending', async () => {
    await db.exec(`
      INSERT INTO "UserRestriction" (id, "userId", type, status) VALUES
        (1, ${DELETED}, 'scam', 'AccountDeleted'),
        (2, ${DELETED}, 'scam', 'Pending');
    `);

    await reopenRestrictionsOfRestoredAccount(DELETED);

    expect(await statuses(DELETED)).toEqual({ 1: 'AccountDeleted', 2: 'Pending' });
  });
});
