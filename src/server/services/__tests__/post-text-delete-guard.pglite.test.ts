import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { postHoldsHeldTextSql } from '~/server/services/post-text-hold';

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
    DELETE FROM "CsamReport"; DELETE FROM "EvidenceHeldUser";
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
