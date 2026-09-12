import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * The REAL `Feedback` migrations, applied to a real Postgres in-process.
 *
 * 🔴 WHY THIS TIER. Every guard in `feedback.service.ts` is a statement about WHICH ROWS MOVE — an
 * UPDATE scoped on the status the operator was looking at, one scoped on `bugId IS NULL`, and a
 * move back to `new` that has to CLEAR two columns rather than stamp them. A mocked builder can
 * only be asked what it was told; it has no rows, so it cannot tell a correctly scoped UPDATE from
 * one scoped to the whole table. Only rows can answer that.
 *
 * It is also the only thing in this app that puts the hand-applied migration SQL under test. The
 * migration is applied by a human, per environment — nothing in CI runs it — so a column name the
 * service and the generated types agree on, and the DDL does not, would otherwise reach production
 * as a 42703 the first time a moderator clicks Save.
 *
 * 🔴 NOT SKIPPABLE. PGlite needs no server, so unlike the `EXPLAIN` tier next door this runs in CI
 * and on a checkout with no database. A test that skips itself proves nothing.
 *
 * 🔴 ONE PLACE THIS TIER DOES NOT MODEL THE PRODUCTION DRIVER — measured, not assumed. A JS `Date`
 * sent as a parameter against a `timestamp WITHOUT time zone` column is serialised by PGlite as UTC
 * (`toISOString`) while the column is READ BACK as local, so the round trip is shifted by the local
 * offset: seeding `2026-09-01T00:00:00Z`, reading it back and filtering `createdAt < thatValue`
 * returns the row itself. node-postgres does not have this — its `prepareValue` calls `dateToString`,
 * which emits LOCAL time with an explicit offset, matching how `postgres-date` parses the column
 * back. So a timestamp comparison that fails HERE is not necessarily wrong in production, and one
 * that passes here is not necessarily right. `feedback.service.ts` sidesteps it by keying its
 * cursor on the row id; anything that must compare timestamps needs a serialiser fixed in this
 * harness first, not a test written around the shift.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** `apps/moderator/src/lib/server/__tests__` → the repo root. */
const MIGRATIONS = join(HERE, '../../../../../../packages/civitai-db-schema/prisma/migrations');

const migration = (name: string) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');

/**
 * The two tables `Feedback`'s foreign keys point at, cut to what these tests touch.
 *
 * `User` and `ModActivity` are stand-ins — their real DDL drags in most of the schema and neither
 * is under test here. `Bug` is NOT a stand-in: it is the real `20260521120000_add_bug_table`
 * migration, because `promoteFeedbackToBug` inserts into it and the point of the test is that the
 * insert satisfies every NOT NULL the real table declares. `DomainColor` is declared because that
 * migration's `domain` column is typed on it.
 */
const PRELUDE = `
CREATE TABLE "User" (
  "id" SERIAL PRIMARY KEY,
  "username" TEXT
);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER,
  "entityType" TEXT,
  "entityId" INTEGER,
  "activity" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TYPE "DomainColor" AS ENUM ('blue', 'green', 'red', 'all');
`;

export async function freshFeedbackDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(PRELUDE);
  await db.exec(migration('20260521120000_add_bug_table'));
  await db.exec(migration('20260813180000_feedback'));
  // The migration under test. Applied by hand per environment — this is the only place anything
  // executes it.
  await db.exec(migration('20260911120000_feedback_triage'));
  return db;
}

/** A client typed exactly as `$lib/server/db`'s, over the in-process database. */
export const feedbackKysely = (db: PGlite): Kysely<DB> =>
  new Kysely<DB>({ dialect: pgliteDialect(db) });

export async function seedUser(db: PGlite, username: string): Promise<number> {
  const res = await db.query<{ id: number }>(
    'INSERT INTO "User" ("username") VALUES ($1) RETURNING "id"',
    [username]
  );
  return res.rows[0].id;
}

export async function seedFeedback(
  db: PGlite,
  row: {
    userId: number;
    area?: string;
    message?: string;
    context?: unknown;
    status?: string;
    createdAt?: string;
  }
): Promise<number> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO "Feedback" ("area", "userId", "message", "context", "status", "createdAt")
     VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING "id"`,
    [
      row.area ?? 'apps-marketplace',
      row.userId,
      row.message ?? 'the list is empty',
      JSON.stringify(row.context ?? {}),
      row.status ?? 'new',
      row.createdAt ?? '2026-09-01T12:00:00.000Z',
    ]
  );
  return res.rows[0].id;
}

export async function readFeedback(db: PGlite, id: number) {
  const res = await db.query<{
    status: string;
    triageNote: string | null;
    handledById: number | null;
    handledAt: Date | null;
    bugId: number | null;
  }>(
    'SELECT "status", "triageNote", "handledById", "handledAt", "bugId" FROM "Feedback" WHERE "id" = $1',
    [id]
  );
  return res.rows[0];
}

export async function countRows(db: PGlite, table: string): Promise<number> {
  const res = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
  return Number(res.rows[0].n);
}
