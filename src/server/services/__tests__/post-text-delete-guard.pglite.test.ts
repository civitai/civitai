import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { postHoldsHeldTextSql, unheldPostTextUpdateSql } from '~/server/services/post-text-hold';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * The "PostText" delete trigger and `post_text_held`, run as written in the migration: held text,
 * and the post that holds it, can't be deleted until the hold is released, by any path.
 */

const MIGRATION = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations/20270108093000_post_text/migration.sql'
);

const SCHEMA = `
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER,
  "reportSentAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "details" JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE "TextScanHold" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "label" TEXT NOT NULL, "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
-- Stands in for the view: the trigger only reads its "userId".
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER PRIMARY KEY);
`;

const AUTHOR = 7;
const OTHER = 8;
let pg: PGlite;

const texts = async () =>
  (await pg.query<{ id: number }>(`SELECT id FROM "PostText" ORDER BY id`)).rows.map((r) => r.id);
const posts = async () =>
  (await pg.query<{ id: number }>(`SELECT id FROM "Post" ORDER BY id`)).rows.map((r) => r.id);

async function addText(postId: number, { csamHeld = false } = {}) {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "PostText" ("postId", "userId", "index", "content", "csamHeld", "updatedAt")
     VALUES ($1, $2, 0, '<p>x</p>', $3, now()) RETURNING id`,
    [postId, AUTHOR, csamHeld]
  );
  return rows[0].id;
}

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(SCHEMA);
  await pg.exec(readFileSync(MIGRATION, 'utf8'));
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    DELETE FROM "CsamReport"; DELETE FROM "EvidenceHeldUser"; DELETE FROM "TextScanHold";
    UPDATE "PostText" SET "csamHeld" = false;
    DELETE FROM "PostText"; DELETE FROM "Post";
    INSERT INTO "Post" ("id", "userId") VALUES (1, ${AUTHOR}), (2, ${AUTHOR});
  `);
});

describe('PostText delete trigger', () => {
  it('deletes text that is not held, alone and with its post', async () => {
    const id = await addText(1);
    await addText(2);
    await pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id]);
    await pg.query(`DELETE FROM "Post" WHERE id = 2`);
    expect(await texts()).toEqual([]);
    expect(await posts()).toEqual([1]);
  });

  it('refuses a raw delete of text whose CSAM hold is pending', async () => {
    const id = await addText(1, { csamHeld: true });
    await expect(pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id])).rejects.toThrow(
      /cannot be deleted while it is held/
    );
    expect(await texts()).toEqual([id]);
  });

  it('refuses the cascade from its post, keeping the post', async () => {
    const id = await addText(1, { csamHeld: true });
    await expect(pg.query(`DELETE FROM "Post" WHERE id = 1`)).rejects.toThrow(
      /cannot be deleted while it is held/
    );
    expect(await texts()).toEqual([id]);
    expect(await posts()).toEqual([1, 2]);
  });

  it("holds text while an evidence hold covers its author, and not once it doesn't", async () => {
    const id = await addText(1);
    await pg.query(`INSERT INTO "EvidenceHeldUser" ("userId") VALUES ($1)`, [AUTHOR]);
    await expect(pg.query(`DELETE FROM "Post" WHERE id = 1`)).rejects.toThrow(/held/);
    await pg.query(`DELETE FROM "EvidenceHeldUser"`);
    await pg.query(`DELETE FROM "Post" WHERE id = 1`);
    expect(await texts()).not.toContain(id);
  });

  it('holds text while a report that still holds names its author or quotes its post', async () => {
    const id = await addText(1);
    await pg.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [AUTHOR]);
    await expect(pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id])).rejects.toThrow(/held/);

    await pg.query(`UPDATE "CsamReport" SET "userId" = $1`, [OTHER]);
    await pg.query(`UPDATE "CsamReport" SET details = $1`, [
      JSON.stringify({ contextText: [{ source: 'postDescription', id: 1, postId: 1 }] }),
    ]);
    await expect(pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id])).rejects.toThrow(/held/);

    // Sent, it holds for a year from submission, and until it is archived.
    await pg.query(
      `UPDATE "CsamReport" SET "reportSentAt" = now() - interval '364 days', "archivedAt" = now()`
    );
    await expect(pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id])).rejects.toThrow(/held/);
    await pg.query(
      `UPDATE "CsamReport" SET "reportSentAt" = now() - interval '366 days', "archivedAt" = NULL`
    );
    await expect(pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id])).rejects.toThrow(/held/);
    await pg.query(`UPDATE "CsamReport" SET "archivedAt" = now()`);
    await pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id]);
    expect(await texts()).toEqual([]);
  });

  it('holds by a sent report naming the author, and works without "EvidenceHeldUser"', async () => {
    const id = await addText(1);
    await pg.query(`ALTER TABLE "EvidenceHeldUser" RENAME TO "EvidenceHeldUserGone"`);
    try {
      await pg.query(`INSERT INTO "CsamReport" ("userId", "reportSentAt") VALUES ($1, now())`, [
        AUTHOR,
      ]);
      await expect(pg.query(`DELETE FROM "Post" WHERE id = 1`)).rejects.toThrow(
        /cannot be deleted while it is held/
      );
      // The evidence leg is skipped, with one warning per session that the view is gone.
      await pg.query(`DELETE FROM "CsamReport"`);
      const notices: string[] = [];
      const onNotice = (n: { severity?: string; message?: string }) =>
        notices.push(`${n.severity}: ${n.message}`);
      await addText(2);
      await pg.query(`DELETE FROM "Post" WHERE id = 1`, [], { onNotice });
      await pg.query(`DELETE FROM "Post" WHERE id = 2`, [], { onNotice });
      expect(await texts()).toEqual([]);
      expect(notices).toEqual([
        expect.stringMatching(/^WARNING: post_text_held: "EvidenceHeldUser" is missing/),
      ]);
    } finally {
      await pg.query(`ALTER TABLE "EvidenceHeldUserGone" RENAME TO "EvidenceHeldUser"`);
    }
  });

  it('holds every text while the evidence-hold table stands without its view', async () => {
    const id = await addText(1);
    await pg.query(`ALTER TABLE "EvidenceHeldUser" RENAME TO "EvidenceHeldUserGone"`);
    await pg.query(`CREATE TABLE "EvidenceHold" ("userId" INTEGER)`);
    try {
      await expect(pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id])).rejects.toThrow(
        /cannot be deleted while it is held/
      );
    } finally {
      await pg.query(`DROP TABLE "EvidenceHold"`);
      await pg.query(`ALTER TABLE "EvidenceHeldUserGone" RENAME TO "EvidenceHeldUser"`);
    }
  });

  it("doesn't hold text over a report on someone else quoting another post", async () => {
    const id = await addText(1);
    await pg.query(`INSERT INTO "CsamReport" ("userId", details) VALUES ($1, $2)`, [
      OTHER,
      JSON.stringify({ contextText: [{ source: 'postDescription', id: 2, postId: 2 }] }),
    ]);
    await pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id]);
    expect(await texts()).toEqual([]);
  });
});

describe('a CSAM hold on the text', () => {
  const decide = (id: number, status: 'Pending' | 'Confirmed' | 'Dismissed') =>
    pg.query(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status, "createdAt")
       VALUES ('PostText', $1, 'csam', $2, now() - interval '1 day')`,
      [id, status]
    );
  const del = (id: number) => pg.query(`DELETE FROM "PostText" WHERE id = $1`, [id]);

  it('holds it for good once confirmed with no report', async () => {
    const id = await addText(1, { csamHeld: true });
    await decide(id, 'Confirmed');
    await expect(del(id)).rejects.toThrow(/held/);
  });

  /** A report's capture of post 1's text, taken now: after the holds above were raised. */
  const capture = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      contextText: [
        {
          source: 'postDescription',
          id: 1,
          postId: 1,
          capturedAt: new Date().toISOString(),
          ...over,
        },
      ],
    });
  const citing = capture();

  it("holds it, once confirmed with a report quoting its post, for the report's retention and then lets it go", async () => {
    const id = await addText(1, { csamHeld: true });
    await decide(id, 'Confirmed');
    await pg.query(
      `INSERT INTO "CsamReport" ("userId", details, "reportSentAt", "archivedAt") VALUES ($1, $2, now() - interval '364 days', now())`,
      [OTHER, citing]
    );
    await expect(del(id)).rejects.toThrow(/held/);
    await pg.query(`UPDATE "CsamReport" SET "reportSentAt" = now() - interval '366 days'`);
    await del(id);
    expect(await texts()).toEqual([]);
  });

  it("isn't let go by an old report on the author that doesn't quote the post", async () => {
    const id = await addText(1, { csamHeld: true });
    await decide(id, 'Confirmed');
    await pg.query(
      `INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt") VALUES ($1, now() - interval '400 days', now())`,
      [AUTHOR]
    );
    await expect(del(id)).rejects.toThrow(/held/);
    // The control: a report as old that quotes the post has ended its retention.
    await pg.query(`UPDATE "CsamReport" SET details = $1`, [citing]);
    await del(id);
    expect(await texts()).toEqual([]);
  });

  it("isn't let go by a report that captured the post before the hold, or only a comment on it", async () => {
    const id = await addText(1, { csamHeld: true });
    await decide(id, 'Confirmed');
    await pg.query(
      `INSERT INTO "CsamReport" ("userId", details, "reportSentAt", "archivedAt") VALUES ($1, $2, now() - interval '400 days', now())`,
      [OTHER, capture({ capturedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() })]
    );
    await expect(del(id)).rejects.toThrow(/held/);
    await pg.query(`UPDATE "CsamReport" SET details = $1`, [
      capture({ source: 'comment', id: 77 }),
    ]);
    await expect(del(id)).rejects.toThrow(/held/);
    // The control: a capture of the post's text after the hold, its report as old.
    await pg.query(`UPDATE "CsamReport" SET details = $1`, [citing]);
    await del(id);
    expect(await texts()).toEqual([]);
  });

  /** An old sent report whose retention has ended, so only its capture can keep the text. */
  const oldReport = (details: string) =>
    pg.query(
      `INSERT INTO "CsamReport" ("userId", details, "reportSentAt", "archivedAt") VALUES ($1, $2, now() - interval '400 days', now())`,
      [OTHER, details]
    );

  it("isn't let go by a capture of another post's text, taken after the hold", async () => {
    const id = await addText(1, { csamHeld: true });
    await decide(id, 'Confirmed');
    await oldReport(capture({ id: 2, postId: 2 }));
    await expect(del(id)).rejects.toThrow(/held/);
    // The control: the same capture, of this post.
    await pg.query(`UPDATE "CsamReport" SET details = $1`, [citing]);
    await del(id);
    expect(await texts()).toEqual([]);
  });

  /** An instant written at a UTC offset, e.g. 2026-01-01T05:00:00.000+05:00. */
  const atOffset = (ms: number, offsetMinutes: number) => {
    const wall = new Date(ms + offsetMinutes * 60_000).toISOString().slice(0, -1);
    const sign = offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(offsetMinutes);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `${wall}${sign}${hh}:${mm}`;
  };
  const HOUR = 3_600_000;
  const holdAt = () => Date.now() - 86_400_000;

  it('reads a capture time by its instant whatever its offset, and keeps the text over one it cannot read', async () => {
    const id = await addText(1, { csamHeld: true });
    await decide(id, 'Confirmed');
    // Taken 2h before the hold; written at +05:00, its digits read 3h after it.
    await oldReport(capture({ capturedAt: atOffset(holdAt() - 2 * HOUR, 5 * 60) }));
    await expect(del(id)).rejects.toThrow(/held/);
    for (const capturedAt of ['yesterday', '', 12345, null]) {
      await pg.query(`UPDATE "CsamReport" SET details = $1`, [capture({ capturedAt })]);
      await expect(del(id)).rejects.toThrow(/held/);
    }
    await pg.query(`UPDATE "CsamReport" SET details = $1`, [
      JSON.stringify({ contextText: [{ source: 'postDescription', id: 1, postId: 1 }] }),
    ]);
    await expect(del(id)).rejects.toThrow(/held/);
    // The control: taken 2h after the hold; written at -05:00, its digits read 3h before it.
    await pg.query(`UPDATE "CsamReport" SET details = $1`, [
      capture({ capturedAt: atOffset(holdAt() + 2 * HOUR, -5 * 60) }),
    ]);
    await del(id);
    expect(await texts()).toEqual([]);
  });

  it('holds it while a hold is pending, a report or not', async () => {
    const id = await addText(1, { csamHeld: true });
    await decide(id, 'Confirmed');
    await decide(id, 'Pending');
    await pg.query(
      `INSERT INTO "CsamReport" ("userId", details, "reportSentAt", "archivedAt") VALUES ($1, $2, now() - interval '2 years', now())`,
      [AUTHOR, citing]
    );
    await expect(del(id)).rejects.toThrow(/held/);
  });

  it('lets it go once dismissed, which clears csamHeld (control)', async () => {
    const id = await addText(1);
    await decide(id, 'Dismissed');
    await del(id);
    expect(await texts()).toEqual([]);
  });
});

describe('postHoldsHeldTextSql', () => {
  it('lets a bulk post delete skip the post holding held text and delete the rest', async () => {
    const held = await addText(1, { csamHeld: true });
    await addText(2);
    const skip = postHoldsHeldTextSql(Prisma.raw('p.id'));
    await pg.query(
      `DELETE FROM "Post" WHERE id IN (SELECT p.id FROM "Post" p WHERE NOT ${skip.text})`,
      skip.values
    );
    expect(await posts()).toEqual([1]);
    expect(await texts()).toEqual([held]);
  });
});

describe('unheldPostTextUpdateSql', () => {
  const write = async (id: number) => {
    const sql = unheldPostTextUpdateSql(id, '<p>new</p>', true);
    return (await pg.query(sql.text, sql.values)).affectedRows;
  };
  const content = async (id: number) =>
    (await pg.query<{ content: string }>(`SELECT content FROM "PostText" WHERE id = $1`, [id]))
      .rows[0].content;

  it('writes over unheld text, and not over text a hold reached after the check', async () => {
    const free = await addText(1);
    expect(await write(free)).toBe(1);
    expect(await content(free)).toBe('<p>new</p>');

    const held = await addText(2);
    // The caller checked; then the hold landed.
    await pg.query(`UPDATE "PostText" SET "csamHeld" = true WHERE id = $1`, [held]);
    expect(await write(held)).toBe(0);
    expect(await content(held)).toBe('<p>x</p>');
  });
});
