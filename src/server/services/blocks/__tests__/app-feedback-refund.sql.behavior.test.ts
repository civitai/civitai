import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The two `Feedback` statements the moderator App refund relies on — `getAppFeedbackForRefund` and
 * `modResolveAppFeedbackWithRefund` — run as written against an in-process Postgres built from the
 * shipped `Feedback` and `ModActivity` migrations (real columns, the real status CHECK). The refund
 * endpoint's own tests mock both, so this is the only place either statement executes.
 */

const { getAppFeedbackForRefund, modResolveAppFeedbackWithRefund } = await import(
  '~/server/services/blocks/app-feedback.service'
);

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) =>
  readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');

/** The app-block migration is two separately-run parts; `CREATE INDEX CONCURRENTLY` refuses a block. */
function appListingMigrationParts() {
  const sql = migration('20261011120000_feedback_app_listing');
  const marker = '\n-- Part 2 — ';
  const at = sql.indexOf(marker);
  if (at === -1 || sql.indexOf(marker, at + 1) !== -1) throw new Error('Part 2 marker not unique');
  return [sql.slice(0, at), sql.slice(at)];
}

const MODERATOR = 911;
const REPORTER = 912;
const OTHER = 913;
const APP_BLOCK = 'apb_fb_alpha';
const LISTING = 'apl_fb_alpha';

let db: PGlite;
const INT4_ARRAY_OID = 1007;

type Row = {
  status: string;
  triageNote: string | null;
  handledById: number | null;
  handledAt: Date | null;
};
const row = async (id: number) =>
  (
    await db.query<Row>(
      `SELECT "status", "triageNote", "handledById", "handledAt" FROM "Feedback" WHERE "id" = $1`,
      [id]
    )
  ).rows[0];
const activity = async () =>
  (
    await db.query<{ userId: number; entityType: string; activity: string; entityId: number }>(
      `SELECT "userId", "entityType", "activity", "entityId" FROM "ModActivity" ORDER BY "id"`
    )
  ).rows;

async function feedback(
  id: number,
  {
    area = 'app-block',
    userId = REPORTER,
    listing = LISTING as string | null,
    note = null as string | null,
  } = {}
) {
  await db.query(
    `INSERT INTO "Feedback" ("id", "area", "userId", "message", "appListingId", "triageNote")
     VALUES ($1, $2, $3, 'it charged me and showed nothing', $4, $5)`,
    [id, area, userId, area === 'app-block' ? listing : null, note]
  );
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "User" (id INT PRIMARY KEY);
    CREATE TABLE "app_listings" (id TEXT PRIMARY KEY, app_block_id TEXT, revision_of_id TEXT);
    CREATE TYPE "DomainColor" AS ENUM ('blue', 'green', 'red', 'all');
  `);
  await db.exec(migration('20260521120000_add_bug_table'));
  await db.exec(migration('20260813180000_feedback'));
  await db.exec(migration('20260911120000_feedback_triage'));
  for (const part of appListingMigrationParts()) await db.exec(part);
  await db.exec(migration('20230522223742_mod_activity'));
  // CONCURRENTLY cannot run in the multi-statement block `exec` sends; the index is the same.
  await db.exec(migration('20260805120000_mod_activity_append_only').replace(/CONCURRENTLY /g, ''));

  const raw = pgliteRaw(db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  // The resolve runs in a real transaction, so the Feedback write and its ModActivity row commit or
  // roll back together here as they do in Postgres.
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
    db.transaction(async (t) => {
      const run = (strings: TemplateStringsArray, values: unknown[]) => {
        const sql = Prisma.sql(strings, ...values);
        // Prisma sends a JS number array as int[]; PGlite would leave it untyped, and
        // trackModActivity's UNNEST cannot resolve an untyped parameter.
        const paramTypes = sql.values.map((v) => (Array.isArray(v) ? INT4_ARRAY_OID : 0));
        return t.query(sql.text, sql.values, { paramTypes });
      };
      return fn({
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
          (await run(strings, values)).affectedRows ?? 0,
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
          (await run(strings, values)).rows,
      });
    })) as never);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Feedback", "ModActivity", "app_listings", "User" CASCADE;
    INSERT INTO "User" VALUES (${MODERATOR}), (${REPORTER}), (${OTHER});
    INSERT INTO "app_listings" VALUES ('${LISTING}', '${APP_BLOCK}', NULL), ('apl_fb_offsite', NULL, NULL);
  `);
});

const resolve = (
  feedbackId: number,
  extra: Partial<{ reporterUserId: number; resolve: boolean; note: string }> = {}
) =>
  modResolveAppFeedbackWithRefund({
    moderatorId: MODERATOR,
    feedbackId,
    reporterUserId: REPORTER,
    note: 'NOTE-ONE',
    resolve: true,
    ...extra,
  });

describe('getAppFeedbackForRefund', () => {
  it("returns the report's area, reporter and — through its listing — the app block", async () => {
    await feedback(301);
    expect(await getAppFeedbackForRefund(301)).toEqual({
      id: 301,
      area: 'app-block',
      userId: REPORTER,
      appBlockId: APP_BLOCK,
    });
  });

  it('a listing that hosts no block, and a report with no listing, give a null appBlockId', async () => {
    await feedback(302, { listing: 'apl_fb_offsite' });
    await feedback(303, { listing: null });
    expect((await getAppFeedbackForRefund(302))?.appBlockId).toBeNull();
    expect((await getAppFeedbackForRefund(303))?.appBlockId).toBeNull();
  });

  it('a missing report is null', async () => {
    expect(await getAppFeedbackForRefund(399)).toBeNull();
  });
});

describe('modResolveAppFeedbackWithRefund', () => {
  it('resolve=true sets `actioned`, stamps who and when, writes the note and a ModActivity row', async () => {
    await feedback(311);
    expect(await resolve(311)).toBe(true);
    const r = await row(311);
    expect(r).toMatchObject({ status: 'actioned', triageNote: 'NOTE-ONE', handledById: MODERATOR });
    expect(r.handledAt).toBeInstanceOf(Date);
    expect(await activity()).toEqual([
      { userId: MODERATOR, entityType: 'feedback', activity: 'refundAppBuzz', entityId: 311 },
    ]);
  });

  it('resolve=false leaves status and handler untouched but appends the note', async () => {
    await feedback(312);
    expect(await resolve(312, { resolve: false })).toBe(true);
    expect(await row(312)).toEqual({
      status: 'new',
      triageNote: 'NOTE-ONE',
      handledById: null,
      handledAt: null,
    });
    expect(await activity()).toHaveLength(1);
  });

  it('a second call appends to the note rather than overwriting it — another moderator’s text too', async () => {
    await feedback(313, { note: 'EARLIER-MOD-TEXT' });
    await resolve(313, { resolve: false, note: 'NOTE-ONE' });
    await resolve(313, { note: 'NOTE-TWO' });
    expect((await row(313)).triageNote).toBe('EARLIER-MOD-TEXT\nNOTE-ONE\nNOTE-TWO');
  });

  it.each([
    ['filed by someone else', { userId: OTHER }],
    ['not App feedback', { area: 'site' }],
  ])('a report %s is not touched: 0 rows, false, no ModActivity', async (_label, patch) => {
    await feedback(314, patch);
    expect(await resolve(314)).toBe(false);
    expect(await row(314)).toMatchObject({ status: 'new', triageNote: null, handledById: null });
    expect(await activity()).toEqual([]);
  });

  it('control: the same report filed by the reporter is closed', async () => {
    await feedback(315);
    expect(await resolve(315)).toBe(true);
    expect((await row(315)).status).toBe('actioned');
  });
});
