import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import {
  countEvidenceHoldsEnding,
  listEvidenceHeldOwners,
} from '@civitai/db-queries/evidence-hold';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/**
 * Who is "ending", against the real hold migration: the view decides who is held and until when, and
 * these queries read it per owner.
 */

const HOLD_MIGRATION = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../../../packages/civitai-db-schema/prisma/migrations/20261019220000_evidence_hold/migration.sql'
  ),
  'utf-8'
);

const IN_13_DAYS = 1;
const IN_15_DAYS = 2;
const NO_END = 3;
const RELEASED = 4;
const ENDING_ROW_BESIDE_MANUAL = 5;
const ENDING_ROW_BESIDE_LATER_REPORT = 6;
const EXTENDED_PAST_WINDOW = 7;
const TWO_ROWS_ENDING = 8; // two report rows both inside the window: one owner, not two
const JUST_INSIDE = 9;
const JUST_OUTSIDE = 10;
const ENDED_ROW_BESIDE_MANUAL = 11;
const NO_USER_ROW = 12; // held, account row gone: still listed, as the badge still counts them

const DAY_MS = 24 * 60 * 60 * 1000;

let pg: PGlite;
let db: Kysely<DB>;
let reportId = 0;

const report = (userId: number, releaseAt: string) =>
  `INSERT INTO "EvidenceHold" ("userId", "csamReportId", "role", "releaseAt", "reason")
   VALUES (${userId}, ${++reportId}, 'subject', ${releaseAt}, 'report sent');`;
const manual = (userId: number) =>
  `INSERT INTO "EvidenceHold" ("userId", "role", "reason") VALUES (${userId}, 'manual', 'held');`;
const inDays = (days: number) => `now() + interval '${days} days'`;
const inHours = (hours: number) => `now() + interval '${hours} hours'`;

const hostTz = process.env.TZ;

beforeAll(async () => {
  // A zoneless timestamp is parsed as host-local time, so on a UTC host a dropped
  // `AT TIME ZONE 'UTC'` would read correctly. Off UTC, it reads hours out.
  process.env.TZ = 'America/Chicago';
  pg = await PGlite.create();
  // As the app's sessions run: the zoneless columns hold UTC, which `now()` only writes in a UTC session.
  await pg.exec(`
    SET TIME ZONE 'UTC';
    CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
    CREATE TABLE "Image" ("id" INTEGER PRIMARY KEY, "userId" INTEGER, "postId" INTEGER, "metadata" JSONB);
    CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
    CREATE TABLE "CsamReport" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "reportSentAt" TIMESTAMP(3), "details" JSONB);
  `);
  await pg.exec(HOLD_MIGRATION);
  await pg.exec(`
    INSERT INTO "User" ("id", "username") SELECT g, 'user' || g FROM generate_series(1, 11) g;
    ${report(IN_13_DAYS, inDays(13))}
    ${report(IN_15_DAYS, inDays(15))}
    ${manual(NO_END)}
    ${report(RELEASED, inDays(5))}
    UPDATE "EvidenceHold" SET "releasedAt" = now(), "releasedById" = -1, "releaseReason" = 'test'
      WHERE "userId" = ${RELEASED};
    ${report(ENDING_ROW_BESIDE_MANUAL, inDays(5))}
    ${manual(ENDING_ROW_BESIDE_MANUAL)}
    ${report(ENDING_ROW_BESIDE_LATER_REPORT, inDays(5))}
    ${report(ENDING_ROW_BESIDE_LATER_REPORT, inDays(60))}
    INSERT INTO "EvidenceHold"
      ("userId", "csamReportId", "role", "releaseAt", "extendedUntil", "extensionRequestedBy", "extensionReference", "reason")
      VALUES (${EXTENDED_PAST_WINDOW}, 900, 'subject', ${inDays(5)}, ${inDays(
    40
  )}, 'requester', 'ref-1', 'report sent');
    ${report(TWO_ROWS_ENDING, inDays(3))}
    ${report(TWO_ROWS_ENDING, inDays(10))}
    INSERT INTO "EvidenceHold" ("userId", "role", "reason", "releasedAt", "releasedById", "releaseReason")
      VALUES (${TWO_ROWS_ENDING}, 'manual', 'held', now(), -1, 'test');
    ${report(JUST_INSIDE, inHours(14 * 24 - 1))}
    ${report(JUST_OUTSIDE, inHours(14 * 24 + 1))}
    ${manual(ENDED_ROW_BESIDE_MANUAL)}
    ${manual(NO_USER_ROW)}
  `);
  // A report row already past its date: what a row that ran out looks like. Inserted that way, it
  // was never active, which `evidence_hold_guard_end` (update and delete only) does not check.
  await pg.exec(report(ENDED_ROW_BESIDE_MANUAL, `now() - interval '1 day'`));
  db = new Kysely<DB>({ dialect: pgliteDialect(pg) });
});

afterAll(async () => {
  if (hostTz === undefined) delete process.env.TZ;
  else process.env.TZ = hostTz;
  await pg?.close();
});

describe('countEvidenceHoldsEnding', () => {
  it('counts owners whose hold as a whole ends within 14 days, each once', async () => {
    const { owners, earliest } = await countEvidenceHoldsEnding(db);
    // IN_13_DAYS, TWO_ROWS_ENDING (two rows, one owner) and JUST_INSIDE. Out: 15 days, no end
    // date, released, a row ending beside a hold that runs on, an extension past the window.
    expect(owners).toBe(3);
    // The owner's end, not their first row's: TWO_ROWS_ENDING is held until its 10-day row.
    expect(Math.abs(earliest!.getTime() - (Date.now() + 10 * DAY_MS))).toBeLessThan(60_000);
  });
});

describe('listEvidenceHeldOwners', () => {
  it('lists the ending owners, soonest first', async () => {
    const { items, hasMore } = await listEvidenceHeldOwners(db, {
      endingOnly: true,
      limit: 50,
      offset: 0,
    });
    expect(items.map((o) => o.userId)).toEqual([TWO_ROWS_ENDING, IN_13_DAYS, JUST_INSIDE]);
    expect(items[0].username).toBe(`user${TWO_ROWS_ENDING}`);
    expect(items[0].holds.map((h) => h.role)).toEqual(['subject', 'subject']);
    expect(hasMore).toBe(false);
  });

  it('lists every held owner with no end date last, and never a released one', async () => {
    const { items } = await listEvidenceHeldOwners(db, { endingOnly: false, limit: 50, offset: 0 });
    const ids = items.map((o) => o.userId);
    expect(ids).not.toContain(RELEASED);
    // In owner order, so a page boundary inside the no-end-date group is stable.
    expect(ids.slice(-4)).toEqual([
      NO_END,
      ENDING_ROW_BESIDE_MANUAL,
      ENDED_ROW_BESIDE_MANUAL,
      NO_USER_ROW,
    ]);
    expect(items.slice(-4).every((o) => o.heldUntil === null)).toBe(true);
    expect(ids).toHaveLength(11);
    expect(items.at(-1)!.username).toBeNull();
  });

  it("shows an owner's row that has ended beside the hold that keeps them held", async () => {
    const { items } = await listEvidenceHeldOwners(db, { endingOnly: false, limit: 50, offset: 0 });
    const owner = items.find((o) => o.userId === ENDED_ROW_BESIDE_MANUAL)!;
    expect(owner.holds.map((h) => [h.role, h.releaseAt === null])).toEqual([
      ['manual', true],
      ['subject', false],
    ]);
    expect(owner.holds[1].releaseAt!.getTime()).toBeLessThan(Date.now());
  });

  it('reports the extension and who asked for it', async () => {
    const { items } = await listEvidenceHeldOwners(db, { endingOnly: false, limit: 50, offset: 0 });
    const [hold] = items.find((o) => o.userId === EXTENDED_PAST_WINDOW)!.holds;
    expect(hold).toMatchObject({ extensionRequestedBy: 'requester', extensionReference: 'ref-1' });
    expect(Math.abs(hold.extendedUntil!.getTime() - (Date.now() + 40 * DAY_MS))).toBeLessThan(
      60_000
    );
  });

  it('pages', async () => {
    const first = await listEvidenceHeldOwners(db, { endingOnly: true, limit: 2, offset: 0 });
    const second = await listEvidenceHeldOwners(db, { endingOnly: true, limit: 2, offset: 2 });
    expect([first.hasMore, second.hasMore]).toEqual([true, false]);
    expect([...first.items, ...second.items].map((o) => o.userId)).toEqual([
      TWO_ROWS_ENDING,
      IN_13_DAYS,
      JUST_INSIDE,
    ]);
  });
});
