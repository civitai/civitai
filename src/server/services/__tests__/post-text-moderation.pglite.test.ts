import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/**
 * A moderator's refusal and restore of one storyline text, run against the "PostText" migrations
 * as written: the refusal hides only that text, and a restore is refused while anything holds it.
 */

let pg: PGlite;
vi.mock('~/server/db/kyselyDb', () => ({ kyselyWrite: pgliteKysely(() => pg) }));
const trackModActivity = vi.hoisted(() => vi.fn());
vi.mock('~/server/services/moderator.service', () => ({ trackModActivity }));
const updatePostNsfwLevels = vi.hoisted(() => vi.fn(async () => []));
vi.mock('~/server/services/nsfwLevels.service', () => ({ updatePostNsfwLevels }));

const { getPostTextReportReason, holdPostTextForCsam, refusePostText, restorePostText } =
  await import('~/server/services/post-text-moderation.service');
const { postTextGateRowSql } = await import('~/server/services/post-text-hold');
vi.mock('~/server/services/text-scan/rated-entities', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recomputeRatedEntityNsfwLevel: vi.fn(),
}));
const { applyPostTextTextScan } = await import('~/server/services/text-scan/actions/image-caption');
const { postTextTextScanSubject } = await import(
  '~/server/services/text-scan/profiles/post-text.profile'
);
const { textScanTextHash } = await import('~/server/services/text-scan/prompt');
const { CSAM_HOLD_TEXT_CHARS, pendingCsamHoldFields } = await import(
  '~/server/services/text-scan/actions/csam-hold'
);
const { scanLiftPostText } = await import('~/server/services/post-text-scan-refusal');

const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (dir: string) =>
  readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');

const SCHEMA = `
CREATE TABLE "Post" ("id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "title" TEXT);
CREATE TABLE "Report" ("id" SERIAL PRIMARY KEY, "reason" TEXT, "details" JSONB);
CREATE TABLE "CsamReport" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER,
  "reportSentAt" TIMESTAMP(3),
  "archivedAt" TIMESTAMP(3),
  "details" JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE "TextScanHold" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "label" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'Pending', "textHash" TEXT,
  "userId" INTEGER, "text" TEXT, "reason" TEXT, "meta" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP(3)
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
    DELETE FROM "PostTextReport"; DELETE FROM "Report";
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
      stillRefused: false,
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

  it("puts back a refusal the scan made before the moderator's: readers still do not see it", async () => {
    await restorePostText({ textId: reported, moderatorId: 2 });
    await pg.query(`UPDATE "PostText" SET refused = true WHERE id = $1`, [reported]);
    await refusePostText({ textId: reported, moderatorId: 2 });

    expect(await restorePostText({ textId: reported, moderatorId: 2 })).toEqual({
      ok: true,
      postId: POST,
      changed: true,
      stillRefused: true,
    });
    expect(await row(reported)).toMatchObject({ refused: true, refusedByModerator: false });
    expect(await hiddenFromReaders(reported)).toBe(true);
  });

  it("puts back a refusal the scan made under the moderator's", async () => {
    await pg.query(`UPDATE "PostText" SET "refusedByScan" = true WHERE id = $1`, [reported]);
    expect(await restorePostText({ textId: reported, moderatorId: 2 })).toMatchObject({
      stillRefused: true,
    });
    expect(await hiddenFromReaders(reported)).toBe(true);
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

describe('holdPostTextForCsam', () => {
  const holds = async () =>
    (
      await pg.query<{
        id: number;
        entityId: number;
        status: string;
        userId: number;
        text: string;
        textHash: string;
        meta: unknown;
      }>(
        `SELECT id, "entityId", status, "userId", text, "textHash", meta FROM "TextScanHold" ORDER BY id`
      )
    ).rows;

  it('opens a pending csam hold on the words, sets csamHeld, and hides the text', async () => {
    const result = await holdPostTextForCsam({ textId: reported, moderatorId: 2, reportId: 300 });

    const [hold] = await holds();
    expect(result).toEqual({ postId: POST, holdId: hold.id, changed: true });
    expect(hold).toMatchObject({
      entityId: reported,
      status: 'Pending',
      userId: AUTHOR,
      text: expect.stringContaining('The reported words.'),
      textHash: expect.stringMatching(/\S/),
      meta: { kind: 'moderator', moderatorId: 2, reportId: 300 },
    });
    expect(
      (await pg.query(`SELECT "csamHeld" FROM "PostText" WHERE id = $1`, [reported])).rows
    ).toEqual([{ csamHeld: true }]);
    expect(await hiddenFromReaders(reported)).toBe(true);
    expect(await hiddenFromReaders(sibling)).toBe(false);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  it('leaves a text already held in its pending hold, and records the hold once', async () => {
    const first = await holdPostTextForCsam({ textId: reported, moderatorId: 2 });
    const second = await holdPostTextForCsam({ textId: reported, moderatorId: 3 });

    expect(second).toEqual({ postId: POST, holdId: first?.holdId, changed: false });
    expect(await holds()).toHaveLength(1);
    expect(trackModActivity).toHaveBeenCalledTimes(1);
  });

  it('holds the words as reported beside the words it reads now, when the author changed them', async () => {
    await pg.query(
      `INSERT INTO "Report" (id, details) VALUES (300, '{"postText": {"content": "<p>What was reported.</p>"}}')`
    );
    await pg.query(
      `INSERT INTO "PostTextReport" ("reportId", "postTextId", "postId") VALUES (300, $1, $2)`,
      [reported, POST]
    );

    await holdPostTextForCsam({ textId: reported, moderatorId: 2, reportId: 300 });

    const [hold] = await holds();
    expect(hold.text).toContain('The reported words.');
    expect(hold.text).toContain('As reported');
    expect(hold.text).toContain('What was reported.');
  });

  // Unlike the scan's writer, which replaces a pending hold's text (and so must wait out a claim), a
  // moderator's hold never rewrites one: a hold a moderator is mid-decision on is left as it is.
  it('leaves a pending hold a moderator has claimed untouched, text and claim alike', async () => {
    const meta = { decisionClaim: { by: 9, at: new Date().toISOString() } };
    await pg.query(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status, text, "textHash", meta)
       VALUES ('PostText', $1, 'csam', 'Pending', 'held words', 'h1', $2)`,
      [reported, JSON.stringify(meta)]
    );
    const [before] = await holds();

    const result = await holdPostTextForCsam({ textId: reported, moderatorId: 2, reportId: 300 });

    expect(result).toEqual({ postId: POST, holdId: before.id, changed: false });
    expect(await holds()).toEqual([before]);
    expect(
      (await pg.query(`SELECT "csamHeld" FROM "PostText" WHERE id = $1`, [reported])).rows
    ).toEqual([{ csamHeld: true }]);
    expect(trackModActivity).not.toHaveBeenCalled();
  });

  // The scan's writer stores the same fields (csam-hold.test.ts pins it), so the two rows match.
  it('stores the author and text pendingCsamHoldFields builds, capped like the scan', async () => {
    const content = `<p>${'y'.repeat(CSAM_HOLD_TEXT_CHARS + 10)}</p>`;
    await pg.query(`UPDATE "PostText" SET content = $2 WHERE id = $1`, [reported, content]);

    await holdPostTextForCsam({ textId: reported, moderatorId: 2 });

    const [hold] = await holds();
    expect({ userId: hold.userId, text: hold.text }).toEqual(
      pendingCsamHoldFields(postTextTextScanSubject({ userId: AUTHOR, content }))
    );
    expect(hold.text).toHaveLength(CSAM_HOLD_TEXT_CHARS);
  });

  it('holds words an earlier hold dismissed', async () => {
    await pg.query(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES ('PostText', $1, 'csam', 'Dismissed')`,
      [reported]
    );
    expect(await holdPostTextForCsam({ textId: reported, moderatorId: 2 })).toMatchObject({
      changed: true,
    });
    expect((await holds()).map((h) => h.status)).toEqual(['Dismissed', 'Pending']);
  });

  it('is null for a text that is gone, and holds nothing', async () => {
    expect(await holdPostTextForCsam({ textId: 9999, moderatorId: 2 })).toBeNull();
    expect(await holds()).toEqual([]);
  });
});

/** The scan's Prisma writes on "PostText", run on the pglite table: equality filters and the `nsfwLevel` range. */
function scanWritesOnPglite() {
  dbMock.dbWrite.postText.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (
        await pg.query(
          `SELECT "userId", content, "nsfwLevel", "postId" FROM "PostText" WHERE id = $1`,
          [where.id]
        )
      ).rows[0] ?? null) as never
  );
  dbMock.dbWrite.postText.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => {
    const params: unknown[] = [];
    const bind = (v: unknown) => {
      params.push(v);
      return '$' + params.length;
    };
    const conds = Object.entries(where).flatMap(([k, v]) =>
      v && typeof v === 'object'
        ? Object.entries(v as Record<string, number>).map(
            ([op, n]) => `"${k}" ${op === 'lt' ? '<' : '>'} ${bind(n)}`
          )
        : [`"${k}" = ${bind(v)}`]
    );
    const sets = Object.entries(data).map(([k, v]) => `"${k}" = ${bind(v)}`);
    const { affectedRows } = await pg.query(
      `UPDATE "PostText" SET ${sets.join(', ')} WHERE ${conds.join(' AND ') || 'true'}`,
      params
    );
    return { count: affectedRows ?? 0 };
  }) as never);
  dbMock.dbWrite.textScanHold.findFirst.mockResolvedValue(null as never);
}

describe("a moderator's refusal and the scan, on the table", () => {
  const verdict = (poi: boolean) => ({
    entityId: reported,
    workflowId: 'wf-1',
    textHash: textScanTextHash(
      postTextTextScanSubject({ userId: AUTHOR, content: '<p>The reported words.</p>' })
    ),
    subject: { fields: [], declared: {} },
    outcome: {
      triggeredLabels: [],
      nsfwLevel: 1,
      nsfw: { detectedLevel: 1, declaredLevel: 0, raised: false, reason: 'r' },
      poi: { detected: poi, declared: false, newlyDetected: poi, names: [], reason: 'r' },
      minor: { detected: false, declared: false, newlyDetected: false, reason: 'r' },
    },
  });
  const flags = async () =>
    (
      await pg.query(
        `SELECT refused, "refusedByModerator", "refusedByScan" FROM "PostText" WHERE id = $1`,
        [reported]
      )
    ).rows[0];

  beforeEach(scanWritesOnPglite);

  // The lift is pinned to the words the verdict was about: an edit landing between the scan's read
  // and its write must not be lifted on the old words' verdict.
  it('a clean verdict does not lift the refusal of words the author has since changed', async () => {
    await applyPostTextTextScan(verdict(true) as never);
    await pg.query(`UPDATE "PostText" SET content = '<p>Edited words.</p>' WHERE id = $1`, [
      reported,
    ]);

    await scanLiftPostText(reported, '<p>The reported words.</p>');

    expect(await flags()).toMatchObject({ refused: true });
    expect(await hiddenFromReaders(reported)).toBe(true);
  });

  it("refuses with no moderator refusal as before: the scan's verdict is `refused` itself", async () => {
    await applyPostTextTextScan(verdict(true) as never);
    expect(await flags()).toEqual({
      refused: true,
      refusedByModerator: false,
      refusedByScan: false,
    });
    expect(await hiddenFromReaders(reported)).toBe(true);
    expect(await hiddenFromReaders(sibling)).toBe(false);
  });

  it('keeps a scan refusal made under the refusal through the restore, and a clean verdict lets the text back', async () => {
    await refusePostText({ textId: reported, moderatorId: 2 });

    await applyPostTextTextScan(verdict(true) as never);
    expect(await flags()).toEqual({ refused: true, refusedByModerator: true, refusedByScan: true });

    // A clean verdict does not lift the moderator's refusal.
    await applyPostTextTextScan(verdict(false) as never);
    expect(await flags()).toEqual({
      refused: true,
      refusedByModerator: true,
      refusedByScan: false,
    });
    expect(await hiddenFromReaders(reported)).toBe(true);

    await applyPostTextTextScan(verdict(true) as never);
    expect(await restorePostText({ textId: reported, moderatorId: 2 })).toMatchObject({
      stillRefused: true,
    });
    expect(await hiddenFromReaders(reported)).toBe(true);

    await applyPostTextTextScan(verdict(false) as never);
    expect(await flags()).toEqual({
      refused: false,
      refusedByModerator: false,
      refusedByScan: false,
    });
    expect(await hiddenFromReaders(reported)).toBe(false);
  });
});

// The endpoint's hold gate: a report authorises a hold only on the text it is about.
describe('getPostTextReportReason', () => {
  beforeEach(async () => {
    await pg.query(
      `INSERT INTO "Report" (id, reason, details) VALUES (300, 'TOSViolation', '{"violation": "Child abuse and exploitation"}')`
    );
    await pg.query(
      `INSERT INTO "PostTextReport" ("reportId", "postTextId", "postId") VALUES (300, $1, $2)`,
      [reported, POST]
    );
  });

  it('reads the report on this text', async () => {
    expect(await getPostTextReportReason(300, reported)).toMatchObject({
      reason: 'TOSViolation',
      details: { violation: 'Child abuse and exploitation' },
    });
  });

  it('is null for a report on another text, so it cannot authorise a hold there', async () => {
    expect(await getPostTextReportReason(300, sibling)).toBeNull();
  });
});
