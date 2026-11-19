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
  "reason" TEXT NOT NULL DEFAULT 'quotes the held words', "decisionNote" TEXT,
  "textHash" TEXT NOT NULL DEFAULT 'h',
  "meta" JSONB, "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER PRIMARY KEY);
CREATE TABLE "EvidenceHold" ("id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "releasedAt" TIMESTAMP(3));
CREATE TABLE "Appeal" ("id" SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "status" TEXT NOT NULL);
CREATE SCHEMA label_store;
CREATE TABLE label_store.subject (
  "id" SERIAL PRIMARY KEY, "subjectType" TEXT, "subjectId" TEXT, "snapshot" JSONB, "excludedReason" TEXT
);
CREATE TABLE label_store.label (
  "id" SERIAL PRIMARY KEY, "subjectId" INTEGER NOT NULL REFERENCES label_store.subject ("id") ON DELETE CASCADE,
  "family" TEXT NOT NULL, "reasonNote" TEXT
);
CREATE FUNCTION label_store.exclude(p_type TEXT, p_id TEXT, p_reason TEXT) RETURNS INTEGER AS $$
  UPDATE label_store.subject SET "snapshot" = NULL, "excludedReason" = p_reason
  WHERE "subjectType" = p_type AND "subjectId" = p_id RETURNING 1
$$ LANGUAGE sql;
`;

const AUTHOR = 7;
let pg: PGlite;

const { purgeConfirmedCsamText } = await import('~/server/services/text-scan/csam-text-retention');
const { markCsamHoldReported, referCsamHoldToLead } = await import(
  '~/server/services/text-scan/csam-hold-decision'
);

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
    `INSERT INTO "PostText" ("postId", "userId", "index", "content", "csamHeld", "updatedAt")
     VALUES ($1, $2, 0, '<p>x</p>', true, now()) RETURNING id`,
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
    `INSERT INTO label_store.subject ("subjectType", "subjectId", "snapshot")
     VALUES ('post_text_text', $1, '{"text":"held words"}')`,
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
  await pg.exec(migration('20271119030000_post_text_csam_retention'));
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
    DELETE FROM "Appeal"; DELETE FROM "TextScanHold"; DELETE FROM label_store.label;
    DELETE FROM label_store.subject;
    UPDATE "PostText" SET "csamHeld" = false;
    DELETE FROM "PostText"; DELETE FROM "Post";
    INSERT INTO "Post" ("id", "userId") VALUES (1, ${AUTHOR}), (2, ${AUTHOR});
  `);
});

describe('post_text_held: a confirmed hold with no report', () => {
  it('holds a "none" confirmation for a year from its latest confirmation, then not', async () => {
    const young = await confirmed({ confirmedDaysAgo: 364 });
    const old = await confirmed({ confirmedDaysAgo: 366, postId: 2 });
    await expect(deleteText(young.textId)).rejects.toThrow(/cannot be deleted while it is held/);
    await deleteText(old.textId);
  });

  it('holds without a confirmation time', async () => {
    const { textId } = await confirmed({ confirmedDaysAgo: null });
    await expect(deleteText(textId)).rejects.toThrow(/held/);
  });

  it("reads the confirmation time off the text's holds", async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(`UPDATE "TextScanHold" SET "decidedAt" = ${ago(10)} WHERE id = $1`, [holdId]);
    await expect(deleteText(textId)).rejects.toThrow(/held/);
    await pg.query(`UPDATE "TextScanHold" SET "decidedAt" = ${ago(366)} WHERE id = $1`, [holdId]);
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

  it('leaves a text the delete trigger would refuse, without spending a delete on it', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    // A report that still holds names the author: `post_text_held` refuses, so the job never picks it.
    await pg.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [AUTHOR]);

    expect(await purgeConfirmedCsamText()).toMatchObject({ deleted: 0, stillHeld: 0 });
    expect(await copies(textId, holdId)).toEqual(KEPT);
  });

  it('never picks a text another confirmed hold gave a reportable choice', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "meta", "decidedAt")
       VALUES ('PostText', $1, 'csam', 'Confirmed', '{"reportChoice":"imagery"}', ${ago(366)})`,
      [textId]
    );
    expect(await purgeConfirmedCsamText()).toMatchObject({ deleted: 0, stillHeld: 0 });
    expect(await copies(textId, holdId)).toEqual(KEPT);
  });

  it('counts as skipped only texts that are due: a year past a "none" confirmation', async () => {
    await pg.query(`INSERT INTO "Appeal" ("userId", status) VALUES ($1, 'Pending')`, [AUTHOR]);
    await confirmed({ confirmedDaysAgo: 366, reportChoice: 'imagery' });
    await confirmed({ confirmedDaysAgo: 364, postId: 2 });

    expect(await purgeConfirmedCsamText()).toMatchObject({
      deleted: 0,
      skipped: { 'pending-appeal': 0 },
    });
  });

  it('counts a delete that fails for another reason and carries on', async () => {
    await confirmed({ confirmedDaysAgo: 366 });
    const second = await confirmed({ confirmedDaysAgo: 366, postId: 2 });
    dbMock.dbWrite.$executeRaw.mockImplementationOnce((async () => {
      throw new Error('connection reset');
    }) as never);

    expect(await purgeConfirmedCsamText()).toMatchObject({ deleted: 1, failed: 1, stillHeld: 0 });
    expect((await copies(second.textId, second.holdId)).row).toBe(false);
  });

  it('pages past rows it skips', async () => {
    await pg.query(`INSERT INTO "Post" ("id", "userId") VALUES (3, ${AUTHOR + 1})`);
    await pg.query(`INSERT INTO "Appeal" ("userId", status) VALUES ($1, 'Pending')`, [AUTHOR]);
    await confirmed({ confirmedDaysAgo: 366 });
    await confirmed({ confirmedDaysAgo: 366, postId: 2 });
    const other = await pg.query<{ id: number }>(
      `INSERT INTO "PostText" ("postId", "userId", "index", "content", "csamHeld", "updatedAt")
       VALUES (3, ${AUTHOR + 1}, 0, 'x', true, now()) RETURNING id`
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

it('reaches a purgeable text behind more kept ones than its page budget', async () => {
  await pg.query(`INSERT INTO "Post" ("id", "userId") VALUES (3, ${AUTHOR + 1})`);
  await pg.query(`INSERT INTO "Appeal" ("userId", status) VALUES ($1, 'Pending')`, [AUTHOR]);
  await confirmed({ confirmedDaysAgo: 366 });
  await confirmed({ confirmedDaysAgo: 366, postId: 2 });
  const other = await pg.query<{ id: number }>(
    `INSERT INTO "PostText" ("postId", "userId", "index", "content", "csamHeld", "updatedAt")
     VALUES (3, ${AUTHOR + 1}, 0, 'x', true, now()) RETURNING id`
  );
  await pg.query(
    `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "meta", "decidedAt")
     VALUES ('PostText', $1, 'csam', 'Confirmed', '{"reportChoice":"none"}', ${ago(366)})`,
    [other.rows[0].id]
  );

  expect(await purgeConfirmedCsamText({ page: 1, maxPages: 1 })).toMatchObject({
    deleted: 1,
    skipped: { 'pending-appeal': 2 },
    stillHeld: 0,
  });
});

describe('the delete trigger on a confirmed "none" text', () => {
  it('drops the hold copy and snapshot when the author deletes it after the year', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await deleteText(textId);
    expect(await copies(textId, holdId)).toEqual({ row: false, holdText: '', snapshot: null });
  });

  it("leaves no copy of the text anywhere on a redetected hold's row", async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(
      `UPDATE "TextScanHold" SET meta = meta || $2::jsonb, "decisionNote" = 'note: held words'
       WHERE id = $1`,
      [
        holdId,
        JSON.stringify({
          kind: 'redetected',
          priorHoldId: 3,
          textUpdatedAt: '2025-01-01T00:00:00Z',
          context: 'held words in a scan key',
          previous: [{ text: 'earlier held words', textHash: 'h0', reason: 'r' }],
        }),
      ]
    );

    await deleteText(textId);

    const { rows } = await pg.query<{ row: string; meta: Record<string, unknown> }>(
      `SELECT to_jsonb(h)::text AS row, h.meta FROM "TextScanHold" h WHERE id = $1`,
      [holdId]
    );
    expect(rows[0].row).not.toMatch(/held words/);
    expect(rows[0].meta).toEqual({
      decision: 'remove',
      reportChoice: 'none',
      kind: 'redetected',
      priorHoldId: 3,
      decisionNotePurged: true,
      retentionPurgedAt: expect.any(String),
    });
  });

  it("clears a migration-superseded duplicate of the purged hold's text", async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    const dup = await pg.query<{ id: number }>(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "meta", "decisionNote", "decidedAt")
       VALUES ('PostText', $1, 'csam', 'Dismissed', $2::jsonb, 'dup note: held words', ${ago(400)})
       RETURNING id`,
      [textId, JSON.stringify({ decision: 'superseded', superseded: true, supersededBy: holdId })]
    );
    const dupId = dup.rows[0].id;

    await deleteText(textId);

    const { rows } = await pg.query<{ id: number; row: string; meta: Record<string, unknown> }>(
      `SELECT id, to_jsonb(h)::text AS row, h.meta FROM "TextScanHold" h WHERE id = ANY($1) ORDER BY id`,
      [[holdId, dupId]]
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.row).not.toMatch(/held words/);
    expect(rows.find((r) => r.id === dupId)?.meta).toMatchObject({
      decision: 'superseded',
      superseded: true,
      supersededBy: holdId,
      decisionNotePurged: true,
    });
  });

  it("clears the moderator's note on the text's csam hold labels, and only those", async () => {
    const { textId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(
      `INSERT INTO label_store.label ("subjectId", "family", "reasonNote")
       SELECT s."id", f.family, f.note FROM label_store.subject s,
         (VALUES ('csam_text_hold', 'note: held words'), ('other_family', 'kept note')) f(family, note)
       WHERE s."subjectId" = $1`,
      [String(textId)]
    );

    await deleteText(textId);

    const { rows } = await pg.query<{ family: string; reasonNote: string | null }>(
      `SELECT l."family", l."reasonNote" FROM label_store.label l ORDER BY l."family"`
    );
    expect(rows).toEqual([
      { family: 'csam_text_hold', reasonNote: null },
      { family: 'other_family', reasonNote: 'kept note' },
    ]);
  });

  it('refuses to clear notes in any other label family', async () => {
    await expect(
      pg.query(`SELECT label_store.drop_label_notes('post_text_text', '1', 'other_family')`)
    ).rejects.toThrow(/not allowed/);
  });

  it('keeps holding the text for a role not yet granted the note scrub, and releases it once granted', async () => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.exec(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'retention_app') THEN
          CREATE ROLE retention_app NOLOGIN;
        END IF;
      END $$;
      GRANT USAGE ON SCHEMA public, label_store TO retention_app;
      GRANT ALL ON ALL TABLES IN SCHEMA public, label_store TO retention_app;
      REVOKE EXECUTE ON FUNCTION label_store.drop_label_notes(TEXT, TEXT, TEXT) FROM retention_app;
    `);
    const asApp = (sql: string) =>
      pg.transaction(async (tx) => {
        await tx.query('SET LOCAL ROLE retention_app');
        await tx.query(sql);
      });

    await expect(asApp(`DELETE FROM "PostText" WHERE id = ${textId}`)).rejects.toThrow(
      /cannot be deleted while it is held/
    );
    expect(await copies(textId, holdId)).toEqual(KEPT);

    await pg.exec(
      `GRANT EXECUTE ON FUNCTION label_store.drop_label_notes(TEXT, TEXT, TEXT) TO retention_app`
    );
    await asApp(`DELETE FROM "PostText" WHERE id = ${textId}`);
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
  ])('refuses the delete of a text %s, keeping all three', async (_, sql) => {
    const { textId, holdId } = await confirmed({ confirmedDaysAgo: 366 });
    await pg.query(sql);
    await expect(deleteText(textId)).rejects.toThrow(/held/);
    expect(await copies(textId, holdId)).toEqual(KEPT);
  });

  it('applies to a delete cascaded from the post', async () => {
    const young = await confirmed({ confirmedDaysAgo: 300 });
    await expect(pg.query(`DELETE FROM "Post" WHERE id = 1`)).rejects.toThrow(/held/);
    expect(await copies(young.textId, young.holdId)).toEqual(KEPT);

    const old = await confirmed({ confirmedDaysAgo: 366, postId: 2 });
    await pg.query(`DELETE FROM "Post" WHERE id = 2`);
    expect(await copies(old.textId, old.holdId)).toEqual({
      row: false,
      holdText: '',
      snapshot: null,
    });
  });
});

describe('post_text_retention_skip', () => {
  it('keeps a text whose post or owner is unknown', async () => {
    const { rows } = await pg.query<{ a: string; b: string; c: string | null }>(
      `SELECT post_text_retention_skip(NULL, ${AUTHOR}) AS a, post_text_retention_skip(1, NULL) AS b,
              post_text_retention_skip(1, ${AUTHOR}) AS c`
    );
    expect(rows[0]).toEqual({ a: 'unknown-owner', b: 'unknown-owner', c: null });
  });
});

describe('post_text_sync_csam_hold', () => {
  async function text(held = true) {
    const { rows } = await pg.query<{ id: number }>(
      `INSERT INTO "PostText" ("postId", "userId", "index", "content", "csamHeld", "updatedAt")
       VALUES (1, ${AUTHOR}, 0, 'x', $1, now()) RETURNING id`,
      [held]
    );
    return rows[0].id;
  }
  const hold = (textId: number, status: string, decidedDaysAgo: number | null) =>
    pg.query(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "decidedAt")
       VALUES ('PostText', $1, 'csam', $2, ${
         decidedDaysAgo === null ? 'NULL' : ago(decidedDaysAgo)
       })`,
      [textId, status]
    );
  async function synced(textId: number) {
    await pg.query(`SELECT post_text_sync_csam_hold($1)`, [textId]);
    const { rows } = await pg.query<{ held: boolean; days: number | null }>(
      `SELECT "csamHeld" AS held,
              extract(day FROM (now() AT TIME ZONE 'UTC') - post_text_csam_confirmed_at(id))::int AS days
       FROM "PostText" WHERE id = $1`,
      [textId]
    );
    return rows[0];
  }

  it('holds a confirmed text its scan never marked held', async () => {
    const id = await text(false);
    await hold(id, 'Confirmed', 5);
    expect(await synced(id)).toEqual({ held: true, days: 5 });
  });

  it("keeps another hold's confirmation when one hold is dismissed", async () => {
    const id = await text();
    await hold(id, 'Confirmed', 400);
    await hold(id, 'Dismissed', 0);
    expect(await synced(id)).toEqual({ held: true, days: 400 });
  });

  it('clears a text whose only hold is dismissed', async () => {
    const id = await text();
    await hold(id, 'Dismissed', 0);
    expect(await synced(id)).toEqual({ held: false, days: null });
  });

  it('stays held, unconfirmed, while another hold is pending', async () => {
    const id = await text();
    await hold(id, 'Pending', null);
    await hold(id, 'Dismissed', 0);
    expect(await synced(id)).toEqual({ held: true, days: null });
  });

  it('dates the confirmation from the latest confirmed hold', async () => {
    const id = await text();
    await hold(id, 'Confirmed', 400);
    await hold(id, 'Confirmed', 10);
    expect(await synced(id)).toEqual({ held: true, days: 10 });
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

describe('markCsamHoldReported', () => {
  const hold = async (status: string, label = 'csam') =>
    (
      await pg.query<{ id: number }>(
        `INSERT INTO "TextScanHold" ("entityType", "entityId", "label", "status", "meta")
         VALUES ('ChatMessage', 1, $2, $1, '{"decision":"remove","reportChoice":"imagery"}') RETURNING id`,
        [status, label]
      )
    ).rows[0].id;
  const meta = async (id: number) =>
    (
      await pg.query<{ meta: Record<string, unknown> }>(
        `SELECT meta FROM "TextScanHold" WHERE id = $1`,
        [id]
      )
    ).rows[0].meta;

  it('records who marked a confirmed hold included in a report, and keeps the decision', async () => {
    const id = await hold('Confirmed');
    await markCsamHoldReported({ holdId: id, actor: { id: 7 } });
    expect(await meta(id)).toMatchObject({
      decision: 'remove',
      reportChoice: 'imagery',
      reportIncluded: { by: 7 },
    });
  });

  it('refuses a pending hold, a non-csam hold and a second mark', async () => {
    const pending = await hold('Pending');
    const other = await hold('Confirmed', 'minor');
    const marked = await hold('Confirmed');
    await markCsamHoldReported({ holdId: marked, actor: { id: 7 } });
    for (const id of [pending, other, marked])
      await expect(markCsamHoldReported({ holdId: id, actor: { id: 8 } })).rejects.toThrow(
        /not confirmed, already marked or missing/
      );
    expect(await meta(pending)).not.toHaveProperty('reportIncluded');
    expect(await meta(marked)).toMatchObject({ reportIncluded: { by: 7 } });
  });
});
