import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type { Removal } from '~/server/jobs/appeal-decision-records';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({
  db: null as unknown as PGlite,
  ch: null as null | { $query: ReturnType<typeof vi.fn> },
}));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get clickhouse() {
    return holder.ch;
  },
}));

// PGlite infers parameter types where Prisma binds JS numbers as int8, so binding mistakes (the
// make_interval kind) are invisible here; the no-bound-make-interval guard covers those.
type Raw = ReturnType<typeof pgliteRaw>;
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);

const {
  sweepExcludedRecords,
  sweepLabelStore,
  fillRemovalLabels,
  recordRestoredLevels,
  removalLabelsFromClickhouse,
  runAppealDecisionRecords,
} = await import('~/server/jobs/appeal-decision-records');

const MIGRATIONS = [
  '20261020120000_appeal_decision_record',
  '20261021120000_appeal_decision_record_training_copy',
  '20261103120000_label_store',
].map((dir) =>
  path.resolve(
    __dirname,
    `../../../../packages/civitai-db-schema/prisma/migrations/${dir}/migration.sql`
  )
);

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "AppealStatus" AS ENUM ('Pending', 'Approved', 'Rejected', 'Void');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Model', 'Model3D');
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY,
      "userId" integer NOT NULL,
      "url" text NOT NULL,
      "pHash" bigint,
      "meta" jsonb,
      "metadata" jsonb,
      "ingestion" text NOT NULL DEFAULT 'Scanned',
      "nsfwLevel" integer NOT NULL DEFAULT 0,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "aiNsfwLevel" integer NOT NULL DEFAULT 0,
      "blockedFor" text,
      "needsReview" text
    );
    CREATE TABLE "Appeal" (
      "id" serial PRIMARY KEY,
      "userId" integer NOT NULL,
      "entityType" "EntityType" NOT NULL,
      "entityId" integer NOT NULL,
      "status" "AppealStatus" NOT NULL DEFAULT 'Pending',
      "resolvedAt" timestamp(3),
      "resolvedReason" text
    );
    CREATE TABLE "CsamReport" ("id" serial PRIMARY KEY, "userId" integer, "images" jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "Model" ("id" integer PRIMARY KEY, "userId" integer NOT NULL, "deletedAt" timestamp(3));
    -- Stand-in with the production columns; the table is not in the Prisma schema.
    CREATE TABLE training_labels (
      url text, label text, "createdAt" timestamp, source text, reason text, old_label text
    );
    -- The scan label tables the label store migration hooks into.
    CREATE TABLE "ScanLabelItem" (
      "id" serial PRIMARY KEY, "imageId" integer NOT NULL, "copyState" text, "copyKey" text, "copiedAt" timestamptz(3)
    );
    CREATE TABLE "ScanLabelFlag" (
      "id" serial PRIMARY KEY, "itemId" integer NOT NULL, "source" text NOT NULL, "flaggerVersion" text NOT NULL,
      "reason" text, "workflowId" text NOT NULL, "flaggedAt" timestamptz(3) NOT NULL, "snapshot" jsonb
    );
    CREATE TABLE "ScanLabelVote" (
      "itemId" integer NOT NULL, "userId" integer NOT NULL, "block" boolean NOT NULL, "reason" text,
      "reasonComment" text, "msOnItem" integer, "createdAt" timestamptz(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "ScanLabelCopyObject" (
      "key" text PRIMARY KEY, "itemId" integer NOT NULL, "imageId" integer NOT NULL,
      "withdrawnAt" timestamptz(3), "withdrawReason" text
    );
  `);
  for (const file of MIGRATIONS) await holder.db.exec(readFileSync(file, 'utf8'));
});

beforeEach(async () => {
  holder.ch = null;
  await holder.db.exec(
    `TRUNCATE "AppealDecisionRecord", "Image", "CsamReport", training_labels, label_store.subject,
       label_store.change RESTART IDENTITY CASCADE`
  );
});

type Rec = {
  appealId: number;
  imageId: number;
  decision?: 'Approved' | 'Rejected';
  removalLabel?: string | null;
  blockedFor?: string | null;
  daysAgo?: number;
  decidedDaysAgo?: number;
};
const record = ({
  appealId,
  imageId,
  decision = 'Approved',
  removalLabel = null,
  blockedFor = 'moderated',
  daysAgo = 1,
  decidedDaysAgo = daysAgo,
}: Rec) =>
  holder.db.query(
    `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel",
       "nsfwLevelLocked", "blockedFor", "decision", "decidedAt", "removalLabel", "createdAt")
     VALUES ($1, $2, $3, 32, true, $7, $4, now() - make_interval(days => $8), $6,
       now() - make_interval(days => $5))`,
    [appealId, imageId, `u-${imageId}`, decision, daysAgo, removalLabel, blockedFor, decidedDaysAgo]
  );
const image = (
  id: number,
  over: {
    nsfwLevel?: number;
    ingestion?: string;
    needsReview?: string;
    blockedFor?: string;
    userId?: number;
  } = {}
) =>
  holder.db.query(
    `INSERT INTO "Image" ("id", "userId", "url", "nsfwLevel", "ingestion", "needsReview", "blockedFor")
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      over.userId ?? 7,
      `u-${id}`,
      over.nsfwLevel ?? 4,
      over.ingestion ?? 'Scanned',
      over.needsReview ?? null,
      over.blockedFor ?? null,
    ]
  );
const label = (imageId: number, value: string, minutesAgo: number, source = 'knight') =>
  holder.db.query(
    `INSERT INTO training_labels (url, label, "createdAt", source)
     VALUES ($1, $2, now() - make_interval(mins => $3), $4)`,
    [`u-${imageId}`, value, minutesAgo, source]
  );
const recordIds = async () =>
  (
    await holder.db.query<{ appealId: number }>(
      `SELECT "appealId" FROM "AppealDecisionRecord" ORDER BY "appealId"`
    )
  ).rows.map((r) => r.appealId);
const rows = async () =>
  (
    await holder.db.query<{
      appealId: number;
      removalLabel: string | null;
      restoredLevel: number | null;
      corrected: boolean;
    }>(
      `SELECT "appealId", "removalLabel", "restoredLevel", ("trainingLabelCorrectedAt" IS NOT NULL) AS corrected
       FROM "AppealDecisionRecord" ORDER BY "appealId"`
    )
  ).rows;
const appealLabels = async () =>
  (
    await holder.db.query(
      `SELECT url, label, source, old_label FROM training_labels WHERE source = 'appeal' ORDER BY url`
    )
  ).rows;
const allLabels = async () =>
  (await holder.db.query(`SELECT url, label, source FROM training_labels ORDER BY url, label`))
    .rows;

describe('sweepExcludedRecords', () => {
  beforeEach(async () => {
    await record({ appealId: 1, imageId: 101 });
    await record({ appealId: 2, imageId: 102 });
    await image(101, { userId: 7 });
    await image(102, { userId: 8 });
  });

  it('deletes a record whose image is later named in a report, and only that one', async () => {
    await holder.db.query(`INSERT INTO "CsamReport" ("images") VALUES ($1)`, [
      JSON.stringify([{ id: 101 }]),
    ]);

    expect(await sweepExcludedRecords()).toEqual({ swept: 1, labels: 0, expired: 0, objects: 0 });
    expect(await recordIds()).toEqual([2]);
  });

  it('deletes every record of an owner later named in a report', async () => {
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (8)`);

    expect((await sweepExcludedRecords()).swept).toBe(1);
    expect(await recordIds()).toEqual([1]);
  });

  it('deletes a record whose image is later flagged', async () => {
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 102`);

    expect((await sweepExcludedRecords()).swept).toBe(1);
    expect(await recordIds()).toEqual([1]);
  });

  it('deletes a record whose image later carries the block marker', async () => {
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = 102`);

    expect((await sweepExcludedRecords()).swept).toBe(1);
    expect(await recordIds()).toEqual([1]);
  });

  it('deletes a record that snapshotted the block marker, after its image is gone', async () => {
    await record({ appealId: 3, imageId: 103, blockedFor: 'CSAM' });

    expect((await sweepExcludedRecords()).swept).toBe(1);
    expect(await recordIds()).toEqual([1, 2]);
  });

  it('keeps everything when nothing is excluded', async () => {
    await holder.db.exec(
      `UPDATE "Image" SET "needsReview" = 'poi', "blockedFor" = 'tos' WHERE id = 102`
    );

    expect(await sweepExcludedRecords()).toEqual({ swept: 0, labels: 0, expired: 0, objects: 0 });
    expect(await recordIds()).toEqual([1, 2]);
  });

  it("removes the training labels this job wrote for a swept record, and nobody else's", async () => {
    await label(101, 'R', 5, 'appeal');
    await label(101, 'Blocked', 50, 'knight');
    await label(102, 'R', 5, 'appeal');
    await holder.db.query(`INSERT INTO "CsamReport" ("images") VALUES ($1)`, [
      JSON.stringify([{ id: 101 }]),
    ]);

    await sweepExcludedRecords();

    expect(await allLabels()).toEqual([
      { url: 'u-101', label: 'Blocked', source: 'knight' },
      { url: 'u-102', label: 'R', source: 'appeal' },
    ]);
  });

  it('deletes records past two years and keeps the ones just inside', async () => {
    await record({ appealId: 3, imageId: 103, daysAgo: 733 });
    await record({ appealId: 4, imageId: 104, daysAgo: 727 });

    expect(await sweepExcludedRecords()).toEqual({ swept: 0, labels: 0, expired: 1, objects: 0 });
    expect(await recordIds()).toEqual([1, 2, 4]);
  });

  it("removes this job's training labels for an excluded image that has no record", async () => {
    await image(105, { userId: 9 });
    await image(106, { userId: 10 });
    await label(105, 'R', 5, 'appeal');
    await label(105, 'Blocked', 50, 'knight');
    await label(106, 'R', 5, 'appeal');
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (9)`);

    expect(await sweepExcludedRecords()).toEqual({ swept: 0, labels: 1, expired: 0, objects: 0 });
    expect(await allLabels()).toEqual([
      { url: 'u-105', label: 'Blocked', source: 'knight' },
      { url: 'u-106', label: 'R', source: 'appeal' },
    ]);
  });

  it.each([
    ['an element without an id', [{ noid: 1 }]],
    ['a string id', [{ id: '101' }]],
    ['an object, not an array', { id: 101 }],
    ['a json null', null],
    ['a fractional id', [{ id: 101.5 }]],
    ['an id beyond int4', [{ id: 5000000000 }]],
  ])('neither throws nor excludes on a report holding %s', async (_, images) => {
    await holder.db.query(`INSERT INTO "CsamReport" ("images") VALUES ($1::jsonb)`, [
      JSON.stringify(images),
    ]);
    await label(101, 'Blocked', 10);

    expect(await sweepExcludedRecords()).toEqual({ swept: 0, labels: 0, expired: 0, objects: 0 });
    expect((await recordRestoredLevels()).restored).toBe(2);
  });

  it('matches an id written as 101.0, as the trigger does', async () => {
    await holder.db.query(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 101.0}]'::jsonb)`);

    expect((await sweepExcludedRecords()).swept).toBe(1);
    expect(await recordIds()).toEqual([2]);
  });
});

describe('fillRemovalLabels', () => {
  it('fills only missing labels, from the lookup, inside the window', async () => {
    await record({ appealId: 1, imageId: 101 });
    // An earlier appeal on the same image, already labelled: its label is not overwritten.
    await record({ appealId: 2, imageId: 101, removalLabel: 'kept' });
    await record({ appealId: 3, imageId: 103 });
    await record({ appealId: 4, imageId: 104, daysAgo: 31 });
    await record({ appealId: 5, imageId: 105, daysAgo: 29 });
    const lookup = vi.fn(
      async (ids: number[]) =>
        new Map(
          ids.filter((id) => id !== 103).map((id) => [id, { label: `label-${id}`, nsfw: 'Soft' }])
        )
    );

    expect(await fillRemovalLabels(lookup)).toBe(2);

    expect(lookup).toHaveBeenCalledWith([101, 103, 105]);
    expect((await rows()).map((r) => [r.appealId, r.removalLabel])).toEqual([
      [1, 'label-101'],
      [2, 'kept'],
      [3, null],
      [4, null],
      [5, 'label-105'],
    ]);
    const ratings = await holder.db.query<{ appealId: number; removalNsfw: string | null }>(
      `SELECT "appealId", "removalNsfw" FROM "AppealDecisionRecord" ORDER BY "appealId"`
    );
    expect(ratings.rows.map((r) => [r.appealId, r.removalNsfw])).toEqual([
      [1, 'Soft'],
      [2, null],
      [3, null],
      [4, null],
      [5, 'Soft'],
    ]);
  });

  it('skips the lookup when nothing is missing', async () => {
    const lookup = vi.fn(async () => new Map<number, Removal>());

    expect(await fillRemovalLabels(lookup)).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('removalLabelsFromClickhouse', () => {
  it('asks for the latest DeleteTOS violation per image and maps the answer', async () => {
    const $query = vi.fn(async () => [
      { imageId: 5, label: 'spam', nsfw: 'Soft' },
      { imageId: 6, label: 'poi', nsfw: '' },
    ]);
    holder.ch = { $query };

    expect(await removalLabelsFromClickhouse([5, 6])).toEqual(
      new Map([
        [5, { label: 'spam', nsfw: 'Soft' }],
        [6, { label: 'poi', nsfw: null }],
      ])
    );

    const [strings, ...values] = $query.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[]
    ];
    const sql = strings.join('?');
    expect(sql).toContain("type = 'DeleteTOS'");
    expect(sql).toContain("argMax(coalesce(nullIf(violationType, ''), tosReason), time) AS label");
    expect(sql).toContain('argMax(toString(nsfw), time) AS nsfw');
    expect(values).toEqual([[5, 6]]);
  });

  it('answers empty without a client or without ids', async () => {
    expect(await removalLabelsFromClickhouse([5])).toEqual(new Map());
    const $query = vi.fn();
    holder.ch = { $query };
    expect(await removalLabelsFromClickhouse([])).toEqual(new Map());
    expect($query).not.toHaveBeenCalled();
  });
});

describe('recordRestoredLevels', () => {
  it('records the restored level and corrects a Blocked training label', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 4 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: 4, corrected: true },
    ]);
    expect(await appealLabels()).toEqual([
      { url: 'u-101', label: 'R', source: 'appeal', old_label: 'Blocked' },
    ]);
  });

  it.each([
    [1, 'PG'],
    [16, 'XXX'],
  ])('labels level %i as %s', async (level, name) => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: level });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect((await appealLabels()).map((l) => l.label)).toEqual([name]);
  });

  it('leaves the training labels alone when the latest one is not Blocked', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 2 });
    await label(101, 'Blocked', 20);
    await label(101, 'PG13', 10);

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: 2, corrected: false },
    ]);
    expect(await appealLabels()).toEqual([]);
  });

  it('records the level of an image that never had a training label', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 2 });

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: 2, corrected: false },
    ]);
  });

  it.each([
    ['still at the Blocked level', { nsfwLevel: 32 }, 1],
    ['unrated', { nsfwLevel: 0 }, 1],
    ['not scanned', { ingestion: 'Pending' }, 1],
    ['decided outside the window', {}, 91],
  ])('waits while the image is %s', async (_, over, daysAgo) => {
    // Created recently in every case: the window is on the decision, not on the row.
    await record({ appealId: 1, imageId: 101, daysAgo: 1, decidedDaysAgo: daysAgo });
    await image(101, { nsfwLevel: 4, ...over });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: null, corrected: false },
    ]);
    expect(await appealLabels()).toEqual([]);
  });

  it('does nothing for a rejection', async () => {
    await record({ appealId: 1, imageId: 101, decision: 'Rejected' });
    await image(101, { nsfwLevel: 4 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: null, corrected: false },
    ]);
    expect(await appealLabels()).toEqual([]);
  });

  it('does nothing for an excluded record the sweep has not reached', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 4 });
    await label(101, 'Blocked', 10);
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (7)`);

    await recordRestoredLevels();

    expect(await appealLabels()).toEqual([]);
    expect(await rows()).toEqual([
      { appealId: 1, removalLabel: null, restoredLevel: null, corrected: false },
    ]);
  });

  it('restores an approval decided just inside the window', async () => {
    await record({ appealId: 1, imageId: 101, daysAgo: 1, decidedDaysAgo: 89 });
    await image(101, { nsfwLevel: 4 });

    expect((await recordRestoredLevels()).restored).toBe(1);
  });

  it('writes one label for two approvals of the same image', async () => {
    await record({ appealId: 1, imageId: 101 });
    await record({ appealId: 2, imageId: 101 });
    await image(101, { nsfwLevel: 8 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();

    expect(await appealLabels()).toEqual([
      { url: 'u-101', label: 'X', source: 'appeal', old_label: 'Blocked' },
    ]);
    expect((await rows()).map((r) => r.corrected)).toEqual([true, true]);
  });

  it('handles a record once, even if the image is labelled Blocked again later', async () => {
    await record({ appealId: 1, imageId: 101 });
    await image(101, { nsfwLevel: 8 });
    await label(101, 'Blocked', 10);

    await recordRestoredLevels();
    await label(101, 'Blocked', 0);
    await recordRestoredLevels();

    expect(await appealLabels()).toEqual([
      { url: 'u-101', label: 'X', source: 'appeal', old_label: 'Blocked' },
    ]);
  });
});

describe('sweepLabelStore', () => {
  const judged = (imageId: number, ownerId?: number) =>
    holder.db.query(
      `SELECT label_store.record_label(
         p_subject_type => 'image', p_subject_id => $1, p_content_hash => $2, p_family => 'test',
         p_question => 'image.block', p_value => 'clear', p_labeller_kind => 'moderator',
         p_source_ref => $3, p_labelled_at => now(), p_labeller_user_id => 900,
         p_snapshot => '{"url": "x"}', p_owner_user_id => $4)`,
      [String(imageId), `h-${imageId}`, `t-${imageId}`, ownerId ?? null]
    );
  const excludedIds = async () =>
    (
      await holder.db.query<{ subjectId: string }>(
        `SELECT "subjectId" FROM label_store.subject WHERE "excludedAt" IS NOT NULL ORDER BY "subjectId"`
      )
    ).rows.map((r) => Number(r.subjectId));

  it('excludes the subject of an image later flagged, and only that one', async () => {
    await image(101, { needsReview: 'csam' });
    await image(102);
    await judged(101);
    await judged(102);

    expect(await sweepLabelStore()).toBe(1);
    expect(await excludedIds()).toEqual([101]);
    const [s] = (
      await holder.db.query<{ snapshot: unknown; excludedReason: string }>(
        `SELECT * FROM label_store.subject WHERE "subjectId" = '101'`
      )
    ).rows;
    expect(s).toMatchObject({ snapshot: null, excludedReason: 'safety' });
  });

  it('excludes the subject of an image a report names, after the image is gone', async () => {
    await judged(103);
    await judged(104);
    await holder.db.query(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 103}]')`);

    expect(await sweepLabelStore()).toBe(1);
    expect(await excludedIds()).toEqual([103]);
  });

  it('excludes every subject of an owner a report names, by the owner hash alone', async () => {
    await judged(105, 8);
    await judged(106, 9);
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (8)`);

    expect(await sweepLabelStore()).toBe(1);
    expect(await excludedIds()).toEqual([105]);
  });

  it('excludes the subject of a live image whose owner a report names', async () => {
    // Judged before the image row existed, so the subject carries no owner hash.
    await judged(108);
    await judged(109);
    await image(108, { userId: 8 });
    await image(109, { userId: 9 });
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (8)`);

    expect(await sweepLabelStore()).toBe(1);
    expect(await excludedIds()).toEqual([108]);
  });

  it('excludes the subject of an image sharing its stored file with an excluded image', async () => {
    await image(110);
    await image(112);
    await holder.db.query(
      `INSERT INTO "Image" ("id", "userId", "url", "needsReview") VALUES (111, 9, 'u-110', 'csam')`
    );
    await judged(110);
    await judged(112);

    expect(await sweepLabelStore()).toBe(1);
    expect(await excludedIds()).toEqual([110]);
  });

  it.each([
    ['is clean', `UPDATE "Image" SET "nsfwLevel" = 4 WHERE id = 90`, false],
    [
      'is flagged, with a lower id',
      `UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 90`,
      true,
    ],
    ['is blocked', `UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = 90`, true],
    ['has a reported owner', `INSERT INTO "CsamReport" ("userId") VALUES (9)`, true],
    ['is named by a report', `INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 90}]')`, true],
    [
      'is named by a report as a string id',
      `INSERT INTO "CsamReport" ("images") VALUES ('[{"id": "90"}]')`,
      true,
    ],
  ])(
    'a subject whose file is shared by an image that %s: excluded %s',
    async (_, setup, excluded) => {
      await image(116);
      await holder.db.query(`INSERT INTO "Image" ("id", "userId", "url") VALUES (90, 9, 'u-116')`);
      await holder.db.exec(setup);
      await judged(116);

      expect(await excludedIds()).toEqual([]);
      expect(await sweepLabelStore()).toBe(excluded ? 1 : 0);
      expect(await excludedIds()).toEqual(excluded ? [116] : []);
    }
  );

  it('excludes the subject of a gone image a report names by a string id', async () => {
    await judged(117);
    await holder.db.query(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": "117"}]')`);

    expect(await sweepLabelStore()).toBe(1);
  });

  it('excludes a subject whose image is gone when another image with its file is excluded', async () => {
    await judged(113);
    await judged(114);
    await holder.db.query(
      `INSERT INTO "Image" ("id", "userId", "url", "needsReview") VALUES (115, 9, 'x', 'csam')`
    );

    // judged() snapshots url "x" for both; neither image row exists, only 115 shares the file.
    await holder.db.query(
      `UPDATE label_store.subject SET snapshot = '{"url": "y"}' WHERE "subjectId" = '114'`
    );
    expect(await sweepLabelStore()).toBe(1);
    expect(await excludedIds()).toEqual([113]);
  });

  it('counts a subject once, and nothing on the next run', async () => {
    await image(107, { blockedFor: 'CSAM' });
    await judged(107);

    expect(await sweepLabelStore()).toBe(1);
    expect(await sweepLabelStore()).toBe(0);
  });
});

describe('sweepLabelStore, model text', () => {
  const ruled = (modelId: number | string) =>
    holder.db.query(
      `SELECT label_store.record_label(
         p_subject_type => 'model_text', p_subject_id => $1, p_content_hash => $2, p_family => 'text_scan',
         p_question => 'text_scan.model.poi', p_value => 'flag', p_labeller_kind => 'moderator',
         p_source_ref => $3, p_labelled_at => now(), p_labeller_user_id => 900,
         p_snapshot => '{"text": "owner text"}', p_owner_user_id => 5)`,
      [String(modelId), `h-${modelId}`, `m-${modelId}`]
    );
  const subjects = async () =>
    (
      await holder.db.query<{
        subjectId: string;
        excludedReason: string | null;
        snapshot: unknown;
        labels: number;
      }>(
        `SELECT s."subjectId", s."excludedReason", s.snapshot,
           (SELECT count(*)::int FROM label_store.label l WHERE l."subjectId" = s.id) AS labels
         FROM label_store.subject s WHERE s."subjectType" = 'model_text' ORDER BY s."subjectId"`
      )
    ).rows;

  const judged = (imageId: number) =>
    holder.db.query(
      `SELECT label_store.record_label(
         p_subject_type => 'image', p_subject_id => $1, p_content_hash => $2, p_family => 'test',
         p_question => 'image.block', p_value => 'clear', p_labeller_kind => 'moderator',
         p_source_ref => $3, p_labelled_at => now(), p_labeller_user_id => 900,
         p_snapshot => '{"url": "x"}')`,
      [String(imageId), `h-${imageId}`, `t-${imageId}`]
    );

  beforeEach(async () => {
    await holder.db.exec(`TRUNCATE "Model"`);
  });

  it('drops the text of a model deleted or gone, and keeps its judgements', async () => {
    await holder.db.exec(`
      INSERT INTO "Model" (id, "userId", "deletedAt") VALUES (1, 5, NULL), (2, 5, now());
    `);
    for (const id of [1, 2, 3]) await ruled(id);
    await image(101, { needsReview: 'csam' });
    await judged(101);

    expect(await sweepLabelStore()).toBe(3);
    expect(await subjects()).toEqual([
      { subjectId: '1', excludedReason: null, snapshot: { text: 'owner text' }, labels: 1 },
      { subjectId: '2', excludedReason: 'removed', snapshot: null, labels: 1 },
      { subjectId: '3', excludedReason: 'removed', snapshot: null, labels: 1 },
    ]);
    expect(await sweepLabelStore()).toBe(0);
  });

  // An id no model can have must not fail the sweep (a cast error would abort the whole run); no
  // model owns it, so its text goes like a deleted model's.
  it('does not fail on a subject id that is not an int4 model id', async () => {
    await holder.db.exec(`INSERT INTO "Model" (id, "userId") VALUES (1, 5)`);
    await ruled(1);
    await ruled('99999999999');
    await ruled('not-a-model');

    expect(await sweepLabelStore()).toBe(2);
    expect((await subjects()).map((s) => [s.subjectId, s.excludedReason])).toEqual([
      ['1', null],
      ['99999999999', 'removed'],
      ['not-a-model', 'removed'],
    ]);
  });
});

describe('the nightly run', () => {
  it('sweeps before it labels or corrects anything', async () => {
    await record({ appealId: 1, imageId: 101 });
    await record({ appealId: 2, imageId: 102 });
    await image(101, { userId: 7, nsfwLevel: 4 });
    await image(102, { userId: 8, nsfwLevel: 4 });
    await label(101, 'Blocked', 10);
    await label(102, 'Blocked', 10);
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (8)`);
    const lookup = vi.fn(
      async (ids: number[]) => new Map(ids.map((id) => [id, { label: 'spam', nsfw: null }]))
    );

    expect(await runAppealDecisionRecords(lookup)).toEqual({
      swept: 1,
      labels: 0,
      expired: 0,
      objects: 0,
      storeExcluded: 1,
      labelled: 1,
      restored: 1,
      corrected: 1,
    });
    expect(lookup).toHaveBeenCalledWith([101]);
    expect((await appealLabels()).map((l) => l.url)).toEqual(['u-101']);
    expect(
      (
        await holder.db.query(
          `SELECT "subjectId", "excludedReason" FROM label_store.subject WHERE "excludedAt" IS NOT NULL`
        )
      ).rows
    ).toEqual([{ subjectId: '102', excludedReason: 'safety' }]);
  });
});

describe('the store sweep, absent or failing', () => {
  it('is inert before the store migration is applied', async () => {
    await holder.db.exec(`ALTER SCHEMA label_store RENAME TO label_store_off`);
    try {
      expect(await sweepLabelStore()).toBe(0);
    } finally {
      await holder.db.exec(`ALTER SCHEMA label_store_off RENAME TO label_store`);
    }
  });

  it('a failing store sweep does not stop the record sweep', async () => {
    await record({ appealId: 2, imageId: 102 });
    await image(102, { userId: 8, nsfwLevel: 4 });
    await holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES (8)`);
    await holder.db.exec(
      `ALTER TABLE label_store.subject ADD CONSTRAINT forced_failure CHECK ("excludedAt" IS NULL) NOT VALID`
    );
    vi.mocked(loggingMock.logToAxiom).mockClear();
    try {
      expect(await runAppealDecisionRecords(vi.fn(async () => new Map()))).toMatchObject({
        swept: 1,
        storeExcluded: 0,
      });
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Label store sweep failed' })
      );
    } finally {
      await holder.db.exec(`ALTER TABLE label_store.subject DROP CONSTRAINT forced_failure`);
    }
  });
});
