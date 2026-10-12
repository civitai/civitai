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
 * The tables `Feedback`'s foreign keys point at, cut to what these tests touch.
 *
 * `User`, `ModActivity` and `app_listings` are stand-ins — their real DDL drags in most of the
 * schema and none is under test here (`app_listings` exists only so the app-block migration's
 * `Feedback_appListingId_fkey` has a target; its real key is TEXT, as here). `Bug` is NOT a
 * stand-in: it is the real `20260521120000_add_bug_table` migration, because `promoteFeedbackToBug`
 * inserts into it and the point of the test is that the insert satisfies every NOT NULL the real
 * table declares. `DomainColor` is declared because that migration's `domain` column is typed on it.
 */
const PRELUDE = `
CREATE TABLE "User" (
  "id" SERIAL PRIMARY KEY,
  "username" TEXT
);
CREATE TABLE "app_listings" (
  "id" TEXT PRIMARY KEY
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

/**
 * The table as it stands on a database that has NOT had `20260911120000_feedback_triage` applied —
 * which is every environment until a human runs it, this page's own deploy window included.
 */
export async function freshPreMigrationDb(): Promise<PGlite> {
  const db = await PGlite.create();
  await db.exec(PRELUDE);
  await db.exec(migration('20260521120000_add_bug_table'));
  await db.exec(migration('20260813180000_feedback'));
  return db;
}

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

/** The app-block migration, applied by hand per environment in TWO separately-run parts. */
const APP_LISTING_MIGRATION = '20261011120000_feedback_app_listing';
/** The header line that opens Part 2 in that file — the split point. */
const PART_2_MARKER = '\n-- Part 2 — ';

/**
 * The app-block migration's two parts, split where the file itself splits them.
 *
 * They cannot be one `exec`: a multi-statement simple query is an implicit transaction block, and
 * Part 2's `CREATE INDEX CONCURRENTLY` refuses to run inside one — which is the same reason a human
 * runs them separately. PGlite DOES execute `CREATE INDEX CONCURRENTLY` on its own (measured on
 * 0.4.6: the index comes back `indisvalid = true`), so Part 2 runs here verbatim, not a stand-in.
 *
 * Throws unless the marker occurs exactly once, so a reworded header fails loudly here instead of
 * silently applying the whole file as "Part 1".
 */
export function appListingMigrationParts(): { part1: string; part2: string } {
  const sql = migration(APP_LISTING_MIGRATION);
  const at = sql.indexOf(PART_2_MARKER);
  if (at === -1 || sql.indexOf(PART_2_MARKER, at + 1) !== -1) {
    throw new Error(
      `expected exactly one "${PART_2_MARKER.trim()}" header in ${APP_LISTING_MIGRATION}`
    );
  }
  return { part1: sql.slice(0, at), part2: sql.slice(at) };
}

/**
 * `freshFeedbackDb` plus `20261011120000_feedback_app_listing` — Part 1, then Part 2 — exactly as a
 * human applies it. The only place anything executes that SQL.
 */
export async function freshAppFeedbackDb(): Promise<PGlite> {
  const db = await freshFeedbackDb();
  const { part1, part2 } = appListingMigrationParts();
  await db.exec(part1);
  await db.exec(part2);
  return db;
}

/** A client typed exactly as `$lib/server/db`'s, over the in-process database. */
export const feedbackKysely = (db: PGlite): Kysely<DB> =>
  new Kysely<DB>({ dialect: pgliteDialect(db) });

/**
 * `username` is NULLABLE on the real table, and a fixture that never exercises that is a fixture
 * whose LEFT JOIN can only ever produce a row — so any ordering or rendering decision about a
 * missing username goes untested. Pass `null` to get one.
 */
export async function seedUser(db: PGlite, username: string | null): Promise<number> {
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
    /**
     * The triage columns, for fixtures that need a row ALREADY handled or linked without going
     * through the service. `handledAt` follows `handledById` so the pair can never disagree — a row
     * with a handler and no timestamp renders as unhandled (`handledByLabel` gates on `handledAt`),
     * which is a state the service never writes and a fixture should not invent.
     *
     * 🔴 An ISO STRING, like `createdAt` above, never a `Date`. PGlite serialises a `Date`
     * parameter as UTC and reads a `timestamp WITHOUT time zone` column back as local — see this
     * file's header — so a `Date` here seeds a value shifted by the local offset.
     */
    handledById?: number | null;
    bugId?: number | null;
    /**
     * 🔴 THE COLUMN NO SCREEN CAN WRITE ANY MORE. The panel's note box is gone, so a stored note can
     * only ever be READ or DESTROYED from here on — which is precisely why a fixture has to be able
     * to put one there: the guard worth having is that a triage posting no note leaves it standing.
     *
     * ⚠️ The column arrives with `20260911120000_feedback_triage`, so this is usable on
     * `freshFeedbackDb` only — `freshPreMigrationDb` is the table WITHOUT it, and passing a note
     * there fails on the INSERT rather than silently doing nothing.
     */
    triageNote?: string | null;
  }
): Promise<number> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO "Feedback"
       ("area", "userId", "message", "context", "status", "createdAt", "handledById", "handledAt", "bugId"${
         row.triageNote === undefined ? '' : ', "triageNote"'
       })
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9${
       row.triageNote === undefined ? '' : ', $10'
     }) RETURNING "id"`,
    [
      row.area ?? 'apps-marketplace',
      row.userId,
      row.message ?? 'the list is empty',
      JSON.stringify(row.context ?? {}),
      row.status ?? 'new',
      row.createdAt ?? '2026-09-01T12:00:00.000Z',
      row.handledById ?? null,
      row.handledById == null ? null : '2026-09-02T09:00:00.000Z',
      row.bugId ?? null,
      ...(row.triageNote === undefined ? [] : [row.triageNote]),
    ]
  );
  return res.rows[0].id;
}

/** A `Bug` a feedback row can point at. `updatedAt` is NOT NULL with no default — see the service. */
export async function seedBug(db: PGlite, title: string): Promise<number> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO "Bug" ("title", "summary", "status", "updatedAt")
     VALUES ($1, $1, 'Open', '2026-09-01T12:00:00.000Z') RETURNING "id"`,
    [title]
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
