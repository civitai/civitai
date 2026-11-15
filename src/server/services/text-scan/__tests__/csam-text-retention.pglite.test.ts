import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * One-year retention of confirmed held PostText, run against the migrations as written: when
 * `post_text_held` stops holding a "none" confirmation, and what the purge job keeps anyway.
 */

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (dir: string) =>
  readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');

const SCHEMA = `
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "reportSentAt" TIMESTAMP(3), "archivedAt" TIMESTAMP(3),
  "details" JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE "TextScanHold" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "label" TEXT NOT NULL, "status" TEXT NOT NULL, "text" TEXT NOT NULL DEFAULT 'held words',
  "textHash" TEXT NOT NULL DEFAULT 'h',
  "meta" JSONB, "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER PRIMARY KEY);
CREATE TABLE "EvidenceHold" ("id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "releasedAt" TIMESTAMP(3));
CREATE TABLE "Appeal" ("id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "status" TEXT NOT NULL);
CREATE SCHEMA label_store;
CREATE TABLE label_store.subject (
  "subjectType" TEXT, "subjectId" TEXT, "snapshot" JSONB, "excludedReason" TEXT
);
CREATE FUNCTION label_store.exclude(p_type TEXT, p_id TEXT, p_reason TEXT) RETURNS INTEGER AS $$
  UPDATE label_store.subject SET "snapshot" = NULL, "excludedReason" = p_reason
  WHERE "subjectType" = p_type AND "subjectId" = p_id RETURNING 1
$$ LANGUAGE sql;
`;

const AUTHOR = 7;
let pg: PGlite;

const { purgeConfirmedCsamText } = await import('~/server/services/text-scan/csam-text-retention');
const { referCsamHoldToLead } = await import('~/server/services/text-scan/csam-hold-decision');

const ago = (days: number) => `(now() AT TIME ZONE 'UTC') - interval '${days} days'`;

/** A confirmed csam PostText hold, its row and its label-store subject. */
async function confirmed({
  confirmedDaysAgo,
  reportChoice = 'none' as string | null,
  postId = 1,
}: {
  confirmedDaysAgo: number | null;
  reportChoice?: string | null;
  postId?: number;
}) {
  const at = confirmedDaysAgo === null ? 'NULL' : ago(confirmedDaysAgo);
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "PostText" ("postId", "userId", "index", "content", "csamHeld", "csamConfirmedAt", "updatedAt")
     VALUES ($1, $2, 0, '<p>x</p>', true, ${at}, now()) RETURNING id`,
    [postId, AUTHOR]
  );
  const textId = rows[0].id;
  const meta = reportChoice ? JSON.stringify({ decision: 'remove', reportChoice }) : '{}';
  const hold = await pg.query<{ id: number }>(
    `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "meta", "decidedAt", "createdAt")
     VALUES ('PostText', $1, 'csam', 'Confirmed', $2::jsonb, ${at}, ${ago(400)}) RETURNING id`,
    [textId, meta]
  );
  await pg.query(
    `INSERT INTO label_store.subject VALUES ('post_text_text', $1, '{"text":"held words"}', NULL)`,
    [String(textId)]
  );
  return { textId, holdId: hold.rows[0].id };
}

const deleteText = (id: number) => pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id]);

/** The three copies the purge drops together: the row, the hold's text, the label-store snapshot. */
async function copies(textId: number, holdId: number) {
  const row = await pg.query(`SELECT 1 FROM "PostText" WHERE id = $1`, [textId]);
  const hold = await pg.query<{ text: string }>(`SELECT text FROM "TextScanHold" WHERE id = $1`, [
    holdId,
  ]);
  const subject = await pg.query<{ snapshot: unknown }>(
    `SELECT snapshot FROM label_store.subject WHERE "subjectId" = $1`,
    [String(textId)]
  );
  return {
    row: row.rows.length > 0,
    holdText: hold.rows[0]?.text,
    snapshot: subject.rows[0]?.snapshot,
  };
}

const KEPT = { row: true, holdText: 'held words', snapshot: { text: 'held words' } };

beforeAll(async () => {
  pg = await PGlite.create();
  // Not UTC, so a timestamp compared without its zone would read by this session's offset.
  await pg.exec(`SET TimeZone = 'America/New_York'`);
  await pg.exec(SCHEMA);
  await pg.exec(migration('20270108093000_post_text'));
  await pg.exec(migration('20271115120000_post_text_csam_confirmed_at'));
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  const raw = pgliteRaw(pg);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  // A real transaction, so the delete trigger's refusal undoes the hold and label-store writes too.
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => Promise<unknown>) =>
    pg.transaction(async (tx) => {
      const inTx = pgliteRaw(tx as unknown as PGlite);
      return fn({ $queryRaw: inTx.queryRaw, $executeRaw: inTx.executeRaw });
    })) as never);
  await pg.exec(`
    DELETE FROM "CsamReport"; DELETE FROM "EvidenceHeldUser"; DELETE FROM "EvidenceHold";
    DELETE FROM "Appeal"; DELETE FROM "TextScanHold"; DELETE FROM label_store.subject;
    UPDATE "PostText" SET "csamHeld" = false;
    DELETE FROM "PostText"; DELETE FROM "Post";
    INSERT INTO "Post" ("id", "userId") VALUES (1, ${AUTHOR}), (2, ${AUTHOR});
  `);
});

describe('post_text_held: a confirmed hold with no report', () => {
  it('holds a "none" confirmation for a year from csamConfirmedAt, then not', async () => {
    const young = await confirmed({ confirmedDaysAgo: 364 });
    const old = await confirmed({ confirmedDaysAgo: 366, postId: 2 });
    await expect(deleteText(young.textId)).rejects.toThrow(/cannot be deleted while it is held/);
    await deleteText(old.textId);
  });

  it('holds without a confirmation time', async () => {
    const { textId } = await confirmed({ confirmedDaysAgo: null });
    await expect(deleteText(textId)).rejects.toThrow(/held/);
  });

  it('reads the confirmation time off the row being deleted', async () => {
    const { textId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(`UPDATE "PostText" SET "csamConfirmedAt" = ${ago(10)} WHERE id = $1`, [textId]);
    await expect(deleteText(textId)).rejects.toThrow(/held/);
    await pg.query(`UPDATE "PostText" SET "csamConfirmedAt" = ${ago(366)} WHERE id = $1`, [textId]);
    await deleteText(textId);
  });

  it('holds a reportable choice past the year while a later report on the author is unsent', async () => {
    const { textId } = await confirmed({ confirmedDaysAgo: 800, reportChoice: 'imagery' });
    await pg.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [AUTHOR]);
    await expect(deleteText(textId)).rejects.toThrow(/held/);
    expect((await purgeConfirmedCsamText()).deleted).toBe(0);
  });

  it('holds a reportable choice, or none recorded, past the year until a report is filed', async () => {
    const reportable = await confirmed({ confirmedDaysAgo: 800, reportChoice: 'imagery' });
    const unrecorded = await confirmed({ confirmedDaysAgo: 800, reportChoice: null, postId: 2 });
    await expect(deleteText(reportable.textId)).rejects.toThrow(/held/);
    await expect(deleteText(unrecorded.textId)).rejects.toThrow(/held/);
  });

  it('still holds past the year on any other ground', async () => {
    const { textId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES ($1)`, [AUTHOR]);
    await expect(deleteText(textId)).rejects.toThrow(/held/);
  });
});

describe('purgeConfirmedCsamText', () => {
  it('deletes a year-old "none" text with its hold copy and label-store snapshot', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    const young = await confirmed({ confirmedDaysAgo: 300, postId: 2 });

    const result = await purgeConfirmedCsamText();

    expect(result.deleted).toBe(1);
    expect(await copies(textId, holdId)).toEqual({ row: false, holdText: '', snapshot: null });
    expect(await copies(young.textId, young.holdId)).toEqual(KEPT);
  });

  it('keeps a text quoted in any CSAM report, even one that no longer holds', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(
      `INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details)
       VALUES (999, ${ago(800)}, ${ago(700)}, $1)`,
      [JSON.stringify({ contextText: [{ source: 'postDescription', postId: 1 }] })]
    );

    const result = await purgeConfirmedCsamText();

    expect(result).toMatchObject({ deleted: 0, skipped: { 'quoted-in-report': 1 } });
    expect(await copies(textId, holdId)).toEqual(KEPT);
  });

  it('keeps a text whose owner has a pending appeal, and not a decided one', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(`INSERT INTO "Appeal" ("userId", status) VALUES ($1, 'Pending')`, [AUTHOR]);

    expect(await purgeConfirmedCsamText()).toMatchObject({
      deleted: 0,
      skipped: { 'pending-appeal': 1 },
    });
    expect(await copies(textId, holdId)).toEqual(KEPT);

    await pg.query(`UPDATE "Appeal" SET status = 'Rejected'`);
    expect((await purgeConfirmedCsamText()).deleted).toBe(1);
  });

  it('keeps a text whose owner has any evidence hold row, a released one too', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(`INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES ($1, now())`, [
      AUTHOR,
    ]);

    expect(await purgeConfirmedCsamText()).toMatchObject({
      deleted: 0,
      skipped: { 'evidence-hold': 1 },
    });
    expect(await copies(textId, holdId)).toEqual(KEPT);
  });

  it('keeps all three when the delete trigger still holds the text', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    // A report that still holds names the author: not a skip of the job's own, so the trigger decides.
    await pg.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [AUTHOR]);

    expect(await purgeConfirmedCsamText()).toMatchObject({ deleted: 0, stillHeld: 1 });
    expect(await copies(textId, holdId)).toEqual(KEPT);
  });

  it('pages past rows it skips', async () => {
    await pg.query(`INSERT INTO "Post" ("id", "userId") VALUES (3, ${AUTHOR + 1})`);
    await pg.query(`INSERT INTO "Appeal" ("userId", status) VALUES ($1, 'Pending')`, [AUTHOR]);
    await confirmed({ confirmedDaysAgo: 366 });
    await confirmed({ confirmedDaysAgo: 366, postId: 2 });
    const other = await pg.query<{ id: number }>(
      `INSERT INTO "PostText" ("postId", "userId", "index", "content", "csamHeld", "csamConfirmedAt", "updatedAt")
       VALUES (3, ${AUTHOR + 1}, 0, 'x', true, ${ago(366)}, now()) RETURNING id`
    );
    await pg.query(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "meta", "decidedAt")
       VALUES ('PostText', $1, 'csam', 'Confirmed', '{"reportChoice":"none"}', ${ago(366)})`,
      [other.rows[0].id]
    );

    expect(await purgeConfirmedCsamText({ page: 1 })).toMatchObject({
      deleted: 1,
      skipped: { 'pending-appeal': 2 },
    });
  });
});

describe('the delete trigger on a confirmed "none" text', () => {
  it('drops the hold copy and snapshot when the author deletes it after the year', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await deleteText(textId);
    expect(await copies(textId, holdId)).toEqual({ row: false, holdText: '', snapshot: null });
  });

  it('drops nothing inside the year', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 300 });
    await expect(deleteText(textId)).rejects.toThrow(/held/);
    expect(await copies(textId, holdId)).toEqual(KEPT);
  });

  it.each([
    [
      'quoted in a report',
      `INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", details)
       VALUES (999, ${ago(800)}, ${ago(
        700
      )}, '{"contextText":[{"source":"postDescription","postId":1}]}')`,
    ],
    ['a pending appeal', `INSERT INTO "Appeal" ("userId", status) VALUES (${AUTHOR}, 'Pending')`],
    [
      'a released evidence hold',
      `INSERT INTO "EvidenceHold" ("userId", "releasedAt") VALUES (${AUTHOR}, now())`,
    ],
  ])('keeps the hold copy and snapshot of a deleted text %s', async (_, sql) => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(sql);
    await deleteText(textId);
    expect(await copies(textId, holdId)).toEqual({ ...KEPT, row: false });
  });
});

describe('referCsamHoldToLead', () => {
  const pendingHold = async (status = 'Pending') =>
    (
      await pg.query<{ id: number }>(
        `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "meta")
         VALUES ('PostText', 1, 'csam', $1, '{"decision":"pending"}') RETURNING id`,
        [status]
      )
    ).rows[0].id;
  const holdRow = async (id: number) =>
    (
      await pg.query<{ status: string; meta: Record<string, unknown>; decidedAt: Date | null }>(
        `SELECT status, meta, "decidedAt" FROM "TextScanHold" WHERE id = $1`,
        [id]
      )
    ).rows[0];

  it('marks a pending hold for lead review and leaves it pending, with no report choice', async () => {
    const id = await pendingHold();
    await referCsamHoldToLead({ holdId: id, textHash: 'h', note: 'unsure', actor: { id: 7 } });
    const row = await holdRow(id);
    expect(row.status).toBe('Pending');
    expect(row.decidedAt).toBeNull();
    expect(row.meta).toMatchObject({
      decision: 'pending',
      needsLeadReview: { by: 7, note: 'unsure' },
    });
    expect(row.meta).not.toHaveProperty('reportChoice');
  });

  it('refuses a decided hold and one whose text changed', async () => {
    const decided = await pendingHold('Confirmed');
    const pending = await pendingHold();
    await expect(
      referCsamHoldToLead({ holdId: decided, textHash: 'h', actor: { id: 7 } })
    ).rejects.toThrow(/already decided, changed or missing/);
    await expect(
      referCsamHoldToLead({ holdId: pending, textHash: 'other', actor: { id: 7 } })
    ).rejects.toThrow(/already decided, changed or missing/);
    expect((await holdRow(pending)).meta).not.toHaveProperty('needsLeadReview');
  });
});
