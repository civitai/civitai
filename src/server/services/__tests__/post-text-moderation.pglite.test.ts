import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A moderator's refusal and restore of one storyline text, run against the "PostText" migrations
 * as written: the refusal hides only that text, and a restore is refused while anything holds it.
 */

let pg: PGlite;
vi.mock('~/server/db/kyselyDb', () => ({ kyselyWrite: pgliteKysely(() => pg) }));
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity: vi.fn() }));
const updatePostNsfwLevels = vi.hoisted(() => vi.fn(async () => []));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updatePostNsfwLevels }));

const { refusePostText, restorePostText } = await import(
  '~/server/services/post-text-moderation.service'
);
const { postTextGateRowSql } = await import('~/server/services/post-text-hold');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (dir: string) =>
  readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');

const SCHEMA = `
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "title" TEXT);
CREATE TABLE "Report" ("id" SERIAL PRIMARY KEY);
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
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER PRIMARY KEY);
`;

const AUTHOR = 7;
const POST = 1;
let reported: number;
let sibling: number;

type Row = { id: number; refused: boolean; refusedByModerator: boolean; content: string };
const rows = async () =>
  (
    await pg.query<Row>(
      `SELECT id, refused, "refusedByModerator", content FROM "PostText" ORDER BY id`
    )
  ).rows;
const row = async (id: number) => (await rows()).find((r) => r.id === id);
/** What every reader's gate reads (`assertPostTextVisible`, `getPostTextsForViewer`). */
const hiddenFromReaders = async (id: number) => {
  const sql = postTextGateRowSql(id);
  return (await pg.query<{ hidden: boolean }>(sql.text, sql.values as unknown[])).rows[0]?.hidden;
};

async function addText(content: string) {
  const { rows } = await pg.query<{ id: number }>(
    `INSERT INTO "PostText" ("postId", "userId", "index", "content", "nsfwLevel", "updatedAt")
     VALUES ($1, $2, 0, $3, 1, now()) RETURNING id`,
    [POST, AUTHOR, content]
  );
  return rows[0].id;
}

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(SCHEMA);
  await pg.exec(migration('20270108093000_post_text'));
  await pg.exec(migration('20271117120000_post_text_report'));
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await pg.exec(`
    DELETE FROM "CsamReport"; DELETE FROM "EvidenceHeldUser"; DELETE FROM "TextScanHold";
    UPDATE "PostText" SET "csamHeld" = false;
    DELETE FROM "PostText"; DELETE FROM "Post";
    INSERT INTO "Post" ("id", "userId", "title") VALUES (${POST}, ${AUTHOR}, 'Chapter one');
  `);
  reported = await addText('<p>The reported words.</p>');
  sibling = await addText('<p>The next slide.</p>');
});

describe('refusePostText', () => {
  it('hides that one text from readers and keeps its row, words and all', async () => {
    expect(await hiddenFromReaders(reported)).toBe(false);

    const result = await refusePostText({ textId: reported, moderatorId: 2 });

    expect(result).toEqual({ ok: true, postId: POST, changed: true });
    expect(await hiddenFromReaders(reported)).toBe(true);
    // The row the author's editor and the moderator queue read is still there, unchanged but for the flags.
    expect(await row(reported)).toEqual({
      id: reported,
      refused: true,
      refusedByModerator: true,
      content: '<p>The reported words.</p>',
    });
    expect(updatePostNsfwLevels).toHaveBeenCalledWith([POST]);
  });

  it('leaves the post and its other texts as they were', async () => {
    const before = (await rows()).filter((r) => r.id !== reported);
    const post = (await pg.query(`SELECT * FROM "Post"`)).rows;

    await refusePostText({ textId: reported, moderatorId: 2 });

    expect((await rows()).filter((r) => r.id !== reported)).toEqual(before);
    expect(await hiddenFromReaders(sibling)).toBe(false);
    expect((await pg.query(`SELECT * FROM "Post"`)).rows).toEqual(post);
  });

  it('says nothing changed for a text a moderator already refused, and null for one that is gone', async () => {
    await refusePostText({ textId: reported, moderatorId: 2 });
    expect(await refusePostText({ textId: reported, moderatorId: 2 })).toEqual({
      ok: true,
      postId: POST,
      changed: false,
    });
    expect(await refusePostText({ textId: 9999, moderatorId: 2 })).toBeNull();
  });
});

describe('restorePostText', () => {
  beforeEach(async () => {
    await refusePostText({ textId: reported, moderatorId: 2 });
  });

  it("lifts a moderator's refusal, and readers see the text again", async () => {
    expect(await restorePostText({ textId: reported, moderatorId: 2 })).toEqual({
      ok: true,
      postId: POST,
      changed: true,
    });
    expect(await row(reported)).toMatchObject({ refused: false, refusedByModerator: false });
    expect(await hiddenFromReaders(reported)).toBe(false);
  });

  it.each([
    ['the text is csamHeld', `UPDATE "PostText" SET "csamHeld" = true WHERE id = $1`],
    [
      'a csam hold is pending on it',
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('PostText', $1, 'csam', 'Pending')`,
    ],
    [
      'a csam hold on it was confirmed',
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('PostText', $1, 'csam', 'Confirmed')`,
    ],
    [
      'a pending CSAM report names its author',
      `INSERT INTO "CsamReport" ("userId") SELECT "userId" FROM "PostText" WHERE id = $1`,
    ],
  ])('is refused while %s, and the text stays refused', async (_, hold) => {
    await pg.query(hold, [reported]);

    expect(await restorePostText({ textId: reported, moderatorId: 2 })).toEqual({
      ok: false,
      postId: POST,
      error: 'held',
    });
    expect(await row(reported)).toMatchObject({ refused: true, refusedByModerator: true });
  });

  it("does not lift a refusal no moderator made (the scan's)", async () => {
    await pg.query(`UPDATE "PostText" SET "refusedByModerator" = false WHERE id = $1`, [reported]);

    expect(await restorePostText({ textId: reported, moderatorId: 2 })).toEqual({
      ok: true,
      postId: POST,
      changed: false,
    });
    expect(await row(reported)).toMatchObject({ refused: true });
  });
});
