import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { constants } from '~/server/common/constants';
import {
  closeGenerationRestrictionsOfDeletedAccount,
  reopenGenerationRestrictionsOfRestoredAccount,
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
const MODERATOR = 99;
const LONG_AGO = '2026-01-01 00:00:00';

let db: PGlite;

type Row = {
  id: number;
  status: string;
  resolvedAt: Date | null;
  resolvedBy: number | null;
  resolvedMessage: string | null;
  updatedAt: Date;
};
const rows = async (userId: number) =>
  (
    await db.query<Row>(
      `SELECT id, status::text AS status, "resolvedAt", "resolvedBy", "resolvedMessage", "updatedAt"
       FROM "UserRestriction" WHERE "userId" = $1 ORDER BY id`,
      [userId]
    )
  ).rows;
const isMuted = async (userId: number) =>
  (await db.query<{ muted: boolean }>(`SELECT muted FROM "User" WHERE id = $1`, [userId])).rows[0]
    .muted;
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
      "updatedAt" timestamp NOT NULL
    );
    CREATE TABLE "User" (id int PRIMARY KEY, muted boolean NOT NULL);
  `);
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "UserRestriction", "User";
    INSERT INTO "User" VALUES (${DELETED}, true), (${BYSTANDER}, false);
  `);
  dbMock.dbWrite.$executeRaw.mockImplementation(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...values);
      const result = await db.query(sql.text, sql.values as unknown[]);
      return result.affectedRows ?? 0;
    }
  );
});

const insert = (values: string) =>
  db.exec(`
    INSERT INTO "UserRestriction" (id, "userId", type, status, "resolvedBy", "updatedAt") VALUES
    ${values};
  `);

describe('closeGenerationRestrictionsOfDeletedAccount', () => {
  it("closes the account's Pending generation cases and nothing it doesn't own", async () => {
    await insert(`
      (1, ${DELETED}, 'generation', 'Pending', NULL, '${LONG_AGO}'),
      (2, ${DELETED}, 'generation', 'Upheld', ${MODERATOR}, '${LONG_AGO}'),
      (3, ${DELETED}, 'generation', 'Overturned', ${MODERATOR}, '${LONG_AGO}'),
      (4, ${BYSTANDER}, 'generation', 'Pending', NULL, '${LONG_AGO}')
    `);

    expect(await closeGenerationRestrictionsOfDeletedAccount(DELETED)).toBe(1);

    expect(await statuses(DELETED)).toEqual({ 1: 'AccountDeleted', 2: 'Upheld', 3: 'Overturned' });
    expect(await statuses(BYSTANDER)).toEqual({ 4: 'Pending' });
  });

  // Deliberate, for whoever widens this to every type: a Pending scam case is what blocks a system
  // release of the mute, and what a moderator unmute closes to restore content and void strikes.
  // Both select Pending, so a closed scam case disarms both. See `mute-release.service.ts`.
  it('leaves scam and bot-account cases Pending', async () => {
    await insert(`
      (1, ${DELETED}, 'scam', 'Pending', NULL, '${LONG_AGO}'),
      (2, ${DELETED}, 'bot-account', 'Pending', NULL, '${LONG_AGO}')
    `);

    expect(await closeGenerationRestrictionsOfDeletedAccount(DELETED)).toBe(0);

    expect(await statuses(DELETED)).toEqual({ 1: 'Pending', 2: 'Pending' });
  });

  it('records the system actor, not a moderator: it is not a ruling', async () => {
    await insert(`(1, ${DELETED}, 'generation', 'Pending', NULL, '${LONG_AGO}')`);

    await closeGenerationRestrictionsOfDeletedAccount(DELETED);

    const [row] = await rows(DELETED);
    expect(row.resolvedBy).toBe(constants.system.user.id);
    expect(row.resolvedAt).not.toBeNull();
    expect(row.resolvedMessage).toBe('Closed automatically: the account was deleted.');
    expect(row.updatedAt.getTime()).toBeGreaterThan(new Date(LONG_AGO).getTime());
  });
});

describe('reopenGenerationRestrictionsOfRestoredAccount', () => {
  it("puts the account's closed cases back to Pending and leaves rulings alone", async () => {
    await insert(`
      (1, ${DELETED}, 'generation', 'AccountDeleted', ${constants.system.user.id}, '${LONG_AGO}'),
      (2, ${DELETED}, 'generation', 'Upheld', ${MODERATOR}, '${LONG_AGO}'),
      (3, ${BYSTANDER}, 'generation', 'AccountDeleted', ${constants.system.user.id}, '${LONG_AGO}'),
      (4, ${DELETED}, 'scam', 'AccountDeleted', ${constants.system.user.id}, '${LONG_AGO}')
    `);
    await db.exec(`UPDATE "UserRestriction" SET "resolvedAt" = now(), "resolvedMessage" = 'x'`);

    expect(await reopenGenerationRestrictionsOfRestoredAccount(DELETED)).toBe(1);

    const [reopened, ruled, scam] = await rows(DELETED);
    expect(reopened).toEqual(
      expect.objectContaining({
        id: 1,
        status: 'Pending',
        resolvedAt: null,
        resolvedBy: null,
        resolvedMessage: null,
      })
    );
    expect(reopened.updatedAt.getTime()).toBeGreaterThan(new Date(LONG_AGO).getTime());
    expect(ruled).toEqual(
      expect.objectContaining({ id: 2, status: 'Upheld', resolvedBy: MODERATOR })
    );
    // Generation only, whatever else a backfill may have closed: a reopened scam case skips the
    // one-Pending-scam-case index check and the scam ledger's own close.
    expect(scam.status).toBe('AccountDeleted');
    expect(await statuses(BYSTANDER)).toEqual({ 3: 'AccountDeleted' });
  });

  // Deliberate: the mute can be lifted while the account is deleted (an overturn of another case no
  // longer sees this one). Reopening then would leave a Pending case on an unmuted account, and
  // re-muting would silently undo that release on restore, so the case stays closed.
  it('leaves the cases closed on an account that is no longer muted, and does not re-mute it', async () => {
    await db.exec(`
      UPDATE "User" SET muted = false WHERE id = ${DELETED};
      UPDATE "User" SET muted = true WHERE id = ${BYSTANDER};
    `);
    await insert(`(1, ${DELETED}, 'generation', 'AccountDeleted', -1, '${LONG_AGO}')`);

    expect(await reopenGenerationRestrictionsOfRestoredAccount(DELETED)).toBe(0);

    expect(await statuses(DELETED)).toEqual({ 1: 'AccountDeleted' });
    expect(await isMuted(DELETED)).toBe(false);
  });

  it('round-trips: a delete then a restore leaves the case as it was', async () => {
    await insert(`(1, ${DELETED}, 'generation', 'Pending', NULL, '${LONG_AGO}')`);

    await closeGenerationRestrictionsOfDeletedAccount(DELETED);
    await reopenGenerationRestrictionsOfRestoredAccount(DELETED);

    expect(await rows(DELETED)).toEqual([
      expect.objectContaining({
        id: 1,
        status: 'Pending',
        resolvedAt: null,
        resolvedBy: null,
        resolvedMessage: null,
      }),
    ]);
  });
});
