import { PGlite } from '@electric-sql/pglite';
import { S3Client } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { createHash, createHmac } from 'crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type { Removal, RemovalLabelLookup } from '~/server/jobs/appeal-decision-records';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

vi.mock('~/server/clickhouse/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  clickhouse: null,
}));

type Raw = ReturnType<typeof pgliteRaw>;
dbMock.dbWrite.$executeRaw.mockImplementation(((...a: Parameters<Raw['executeRaw']>) =>
  pgliteRaw(holder.db).executeRaw(...a)) as never);
// A Date goes as timestamptz, as Prisma sends it: untyped, `${date} - INTERVAL` reads as an interval.
const TIMESTAMPTZ = 1184;
dbMock.dbWrite.$queryRaw.mockImplementation((async (
  strings: TemplateStringsArray | Prisma.Sql,
  ...values: unknown[]
) => {
  if (!Array.isArray(strings)) return pgliteRaw(holder.db).queryRaw(strings);
  const sql = Prisma.sql(strings as TemplateStringsArray, ...values);
  const paramTypes = sql.values.map((v) => (v instanceof Date ? TIMESTAMPTZ : 0));
  return (await holder.db.query(sql.text, sql.values, { paramTypes })).rows;
}) as never);

const {
  appealTrainingHeld,
  appealTrainingStoreFromEnv,
  copyRejectedForTraining,
  isAppealTrainingConfigured,
  createAppealTrainingStore,
  removeErasedOwnerRecords,
  sweepExcludedRecords,
} = await import('~/server/jobs/appeal-decision-records');
const { downvotedTagsToDelete } = await import('~/server/jobs/apply-voted-tags');

const MIGRATIONS = [
  '20261020120000_appeal_decision_record',
  '20261021120000_appeal_decision_record_training_copy',
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
      "ingestion" text NOT NULL DEFAULT 'Blocked',
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
    CREATE TABLE "User" ("id" integer PRIMARY KEY, "deletedAt" timestamp(3), "meta" jsonb);
    CREATE TABLE "ModActivity" (
      "id" serial PRIMARY KEY, "userId" integer, "activity" text NOT NULL, "entityType" text,
      "entityId" integer, "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "Tag" (
      "id" serial PRIMARY KEY, "name" text NOT NULL UNIQUE, "type" text NOT NULL DEFAULT 'UserGenerated'
    );
    CREATE TABLE "TagsOnImageNew" (
      "imageId" integer NOT NULL, "tagId" integer NOT NULL, "attributes" smallint NOT NULL DEFAULT 0,
      PRIMARY KEY ("imageId", "tagId")
    );
    CREATE TABLE "TagsOnImageVote" (
      "imageId" integer NOT NULL, "tagId" integer NOT NULL, "userId" integer NOT NULL,
      "vote" integer NOT NULL, "applied" boolean NOT NULL DEFAULT false,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE VIEW "TagsOnImageDetails" AS SELECT "imageId", "tagId",
      ("attributes" >> 11) & 1 = 1 AS automated,
      ("attributes" >> 10) & 1 = 1 AS disabled,
      ("attributes" >> 9) & 1 = 1 AS "needsReview"
    FROM "TagsOnImageNew";
    CREATE FUNCTION iif(boolean, integer, integer) RETURNS integer
      LANGUAGE sql AS 'SELECT CASE WHEN $1 THEN $2 ELSE $3 END';
    CREATE TABLE training_labels (
      url text, label text, "createdAt" timestamp, source text, reason text, old_label text
    );
  `);
  for (const file of MIGRATIONS) await holder.db.exec(readFileSync(file, 'utf8'));
});

const OWNER_KEY = 'owner-key';
const ownerHashOf = (userId: number) =>
  createHmac('sha256', OWNER_KEY).update(String(userId)).digest('hex');

beforeEach(async () => {
  setEnv({ APPEAL_OWNER_HASH_KEY: OWNER_KEY });
  vi.mocked(loggingMock.logToAxiom).mockClear();
  noLabels.mockClear();
  await holder.db.exec(
    `TRUNCATE "AppealDecisionRecord", "AppealTrainingObjectDeletion", "Image", "CsamReport",
       training_labels, "Appeal", "ModActivity", "User", "Tag", "TagsOnImageNew", "TagsOnImageVote"
       RESTART IDENTITY`
  );
});

// As `get_tag_on_image_attributes` packs a SpineRating tag: source 0, automated, confidence 16.
const SCAN_RATING_ATTRIBUTES = (1 << 11) | 16;
// As the packing does once SpineRating has its own code (10): bit 15 set, so a negative smallint.
const SPINE_CODE_RATING_ATTRIBUTES = ((10 << 12) | (1 << 11) | 16) - 65536;
// A tag a user added: source 1 (User), not automated.
const USER_TAG_ATTRIBUTES = 1 << 12;
// An automated tag from another source: WD14 (3).
const WD14_TAG_ATTRIBUTES = (3 << 12) | (1 << 11);
const tagImage = async (imageId: number, name: string, attributes: number) => {
  await holder.db.query(`INSERT INTO "Tag" ("name") VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
  await holder.db.query(
    `INSERT INTO "TagsOnImageNew" ("imageId", "tagId", "attributes")
     SELECT $1, id, $3 FROM "Tag" WHERE name = $2`,
    [imageId, name, attributes]
  );
};

type Rec = {
  appealId: number;
  imageId: number;
  decision?: 'Approved' | 'Rejected';
  removalLabel?: string | null;
  removalNsfw?: string | null;
  aiNsfwLevel?: number | null;
  /** Ratings the scan stored for the image (automated tags, source bits 0). */
  scanRatings?: string[];
  hoursAgo?: number;
  state?: string | null;
  key?: string | null;
  withImage?: boolean;
  userId?: number;
};
const record = async ({
  appealId,
  imageId,
  decision = 'Rejected',
  removalLabel = 'spam',
  removalNsfw = null,
  aiNsfwLevel = 0,
  scanRatings = [],
  hoursAgo = 0.1,
  state = null,
  key = null,
  withImage = true,
  userId = 7,
}: Rec) => {
  if (withImage)
    await holder.db.query(
      `INSERT INTO "Image" ("id", "userId", "url") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [imageId, userId, `u-${imageId}`]
    );
  for (const name of scanRatings) await tagImage(imageId, name, SCAN_RATING_ATTRIBUTES);
  await holder.db.query(
    `INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel",
       "nsfwLevelLocked", "decision", "decidedAt", "removalLabel", "trainingCopyState",
       "trainingObjectKey", "removalNsfw", "aiNsfwLevel")
     VALUES ($1, $2, $3, 32, true, $4, now() - make_interval(secs => $5), $6, $7, $8, $9, $10)`,
    [
      appealId,
      imageId,
      `u-${imageId}`,
      decision,
      hoursAgo * 3600,
      removalLabel,
      state,
      key,
      removalNsfw,
      aiNsfwLevel,
    ]
  );
};
const states = async () =>
  (
    await holder.db.query<{
      appealId: number;
      removalLabel: string | null;
      state: string | null;
      key: string | null;
    }>(
      `SELECT "appealId", "removalLabel", "trainingCopyState" AS state, "trainingObjectKey" AS key
       FROM "AppealDecisionRecord" ORDER BY "appealId"`
    )
  ).rows;

const fakeStore = () => ({
  copy: vi.fn<(imageUrl: string, key: string) => Promise<void>>(async () => undefined),
  remove: vi.fn<(keys: string[]) => Promise<void>>(async () => undefined),
});
const noLabels = vi.fn(async () => new Map<number, Removal>());
const tombstones = async () =>
  (
    await holder.db.query<{ key: string }>(
      'SELECT key FROM "AppealTrainingObjectDeletion" ORDER BY key'
    )
  ).rows.map((row) => row.key);

const COPIED_LABELS = [
  'bestiality',
  'sexualViolence',
  'mindAlteredNsfw',
  'fecalMatter',
  'gore',
  'anorexia',
  'bodilyFluids',
  'incest',
  'hate',
  'spam',
];
const SKIPPED_LABELS = [
  'minor',
  'animatedMinorNsfw',
  'realisticMinorNsfw',
  'realisticMinor',
  'schoolNsfw',
  'minorViolence',
  'diaper',
  'realPersonNsfw',
  'non-ai',
  'other',
  'tag',
  'manual',
  'Duplicate images',
  'someNewLabel',
];

describe('copyRejectedForTraining', () => {
  it('copies a rejected image with a copyable label and records the object key', async () => {
    await record({ appealId: 1, imageId: 101 });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(await tombstones()).toEqual([]);

    expect(store.copy).toHaveBeenCalledExactlyOnceWith('u-101', '1/u-101');
    expect(await states()).toEqual([
      { appealId: 1, removalLabel: 'spam', state: 'copied', key: '1/u-101' },
    ]);
  });

  it.each(COPIED_LABELS)('copies a record labelled %s', async (removalLabel) => {
    await record({ appealId: 1, imageId: 101, removalLabel });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).toHaveBeenCalledExactlyOnceWith('u-101', '1/u-101');
    expect((await states())[0].state).toBe('copied');
  });

  it.each(SKIPPED_LABELS)('skips, and never copies, a record labelled %s', async (removalLabel) => {
    await record({ appealId: 1, imageId: 101, removalLabel });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).not.toHaveBeenCalled();
    expect(await states()).toEqual([{ appealId: 1, removalLabel, state: 'skipped', key: null }]);
  });

  it.each<[string, string | null, string[], 'copied' | 'skipped']>([
    ['realPerson', 'None', ['pg'], 'copied'],
    ['poi', 'Soft', ['pg13'], 'copied'],
    ['poi', 'None', ['pg-13'], 'copied'],
    ['realPerson', 'None', ['r'], 'skipped'],
    ['poi', 'None', ['x'], 'skipped'],
    ['poi', 'None', ['xxx'], 'skipped'],
    ['realPerson', 'None', [], 'skipped'],
    ['realPerson', 'None', ['pg', 'r'], 'skipped'],
    ['poi', 'Mature', ['pg'], 'skipped'],
    ['poi', 'X', ['pg'], 'skipped'],
    ['poi', null, ['pg'], 'skipped'],
    ['realPerson', 'Blocked', ['pg'], 'skipped'],
    ['realPersonNsfw', 'None', ['pg'], 'skipped'],
  ])(
    'rates a record labelled %s at %s with scan ratings %j: %s',
    async (removalLabel, removalNsfw, scanRatings, state) => {
      await record({ appealId: 1, imageId: 101, removalLabel, removalNsfw, scanRatings });
      const store = fakeStore();

      await copyRejectedForTraining({ store, lookup: noLabels });

      expect(store.copy).toHaveBeenCalledTimes(state === 'copied' ? 1 : 0);
      expect((await states())[0].state).toBe(state);
    }
  );

  it('rates a realPerson record by the scan alone, never by aiNsfwLevel or any other tag', async () => {
    await record({
      appealId: 1,
      imageId: 101,
      removalLabel: 'realPerson',
      removalNsfw: 'None',
      aiNsfwLevel: 1,
    });
    await record({ appealId: 2, imageId: 102, removalLabel: 'realPerson', removalNsfw: 'None' });
    await tagImage(102, 'pg', USER_TAG_ATTRIBUTES);
    await record({
      appealId: 3,
      imageId: 103,
      removalLabel: 'realPerson',
      removalNsfw: 'None',
      scanRatings: ['pg'],
    });
    await tagImage(103, 'r', USER_TAG_ATTRIBUTES);
    await record({
      appealId: 4,
      imageId: 104,
      removalLabel: 'realPerson',
      removalNsfw: 'None',
      scanRatings: ['pg'],
    });
    await tagImage(104, 'r', WD14_TAG_ATTRIBUTES);
    await record({ appealId: 5, imageId: 105, removalLabel: 'realPerson', removalNsfw: 'None' });
    await tagImage(105, 'pg', 0);
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy.mock.calls).toEqual([
      ['u-103', '3/u-103'],
      ['u-104', '4/u-104'],
    ]);
    expect((await states()).map((s) => s.state)).toEqual([
      'skipped',
      'skipped',
      'copied',
      'copied',
      'skipped',
    ]);
  });

  it.each(['spam', 'realPerson'])(
    'never copies a %s record whose image carries a likeness request mark',
    async (removalLabel) => {
      await record({
        appealId: 1,
        imageId: 101,
        removalLabel,
        removalNsfw: 'None',
        scanRatings: ['pg'],
      });
      await record({
        appealId: 2,
        imageId: 102,
        removalLabel,
        removalNsfw: 'None',
        scanRatings: ['pg'],
      });
      await holder.db.exec(
        `INSERT INTO "ModActivity" ("activity", "entityType", "entityId") VALUES ('likenessRequest', 'image', 101)`
      );
      const store = fakeStore();

      await copyRejectedForTraining({ store, lookup: noLabels });

      expect(store.copy.mock.calls).toEqual([['u-102', '2/u-102']]);
      expect((await states()).map((s) => s.state)).toEqual(['skipped', 'copied']);
    }
  );

  it.each([
    [
      'its image is named in a report',
      `INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 101}]')`,
    ],
    ['its owner is named in a report', `INSERT INTO "CsamReport" ("userId") VALUES (7)`],
    ['its image is flagged', `UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 101`],
  ])('skips an excluded record: %s', async (_, sql) => {
    await record({ appealId: 1, imageId: 101 });
    await holder.db.exec(sql);
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).not.toHaveBeenCalled();
    expect((await states())[0].state).toBe('skipped');
  });

  it('skips a record whose stored object an excluded image shares', async () => {
    await record({ appealId: 1, imageId: 101 });
    await holder.db.exec(
      `INSERT INTO "Image" ("id", "userId", "url", "needsReview") VALUES (201, 8, 'u-101', 'csam')`
    );
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).not.toHaveBeenCalled();
    expect((await states())[0].state).toBe('skipped');
  });

  it('deletes the copy when the record is swept while the copy runs', async () => {
    await record({ appealId: 1, imageId: 101 });
    const store = fakeStore();
    store.copy.mockImplementationOnce(async () => {
      await holder.db.exec('DELETE FROM "AppealDecisionRecord"');
    });

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.remove).toHaveBeenCalledExactlyOnceWith(['1/u-101']);
  });

  it('deletes the copy and leaves the record pending when it becomes excluded mid-copy', async () => {
    await record({ appealId: 1, imageId: 101 });
    const store = fakeStore();
    store.copy.mockImplementationOnce(async () => {
      await holder.db.exec('INSERT INTO "CsamReport" ("userId") VALUES (7)');
    });

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.remove).toHaveBeenCalledExactlyOnceWith(['1/u-101']);
    expect(await states()).toEqual([{ appealId: 1, removalLabel: 'spam', state: null, key: null }]);
  });

  it('keeps a copy another run already recorded', async () => {
    await record({ appealId: 1, imageId: 101 });
    const store = fakeStore();
    store.copy.mockImplementationOnce(async () => {
      await holder.db.exec(
        `UPDATE "AppealDecisionRecord" SET "trainingCopyState" = 'copied', "trainingObjectKey" = '1/u-101'`
      );
    });

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.remove).not.toHaveBeenCalled();
  });

  it('queues the copy for deletion when deleting it fails', async () => {
    await record({ appealId: 1, imageId: 101 });
    const store = fakeStore();
    store.copy.mockImplementationOnce(async () => {
      await holder.db.exec('DELETE FROM "AppealDecisionRecord"');
    });
    store.remove.mockRejectedValueOnce(new Error('denied'));

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(await tombstones()).toEqual(['1/u-101']);
  });

  it('skips a record whose image is already gone', async () => {
    await record({ appealId: 1, imageId: 101, withImage: false });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).not.toHaveBeenCalled();
    expect((await states())[0].state).toBe('skipped');
  });

  it('looks up a missing label, stores it, and copies on it', async () => {
    await record({ appealId: 1, imageId: 101, removalLabel: null });
    await record({ appealId: 2, imageId: 102, removalLabel: null });
    await record({ appealId: 3, imageId: 103, removalLabel: null, scanRatings: ['pg'] });
    const lookup = vi.fn<RemovalLabelLookup>(
      async () =>
        new Map([
          [101, { label: 'spam', nsfw: 'X' }],
          [102, { label: 'realisticMinorNsfw', nsfw: 'None' }],
          [103, { label: 'poi', nsfw: 'None' }],
        ])
    );
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup });

    expect(lookup).toHaveBeenCalledExactlyOnceWith([101, 102, 103]);
    expect(store.copy.mock.calls).toEqual([
      ['u-101', '1/u-101'],
      ['u-103', '3/u-103'],
    ]);
    expect(await states()).toEqual([
      { appealId: 1, removalLabel: 'spam', state: 'copied', key: '1/u-101' },
      { appealId: 2, removalLabel: 'realisticMinorNsfw', state: 'skipped', key: null },
      { appealId: 3, removalLabel: 'poi', state: 'copied', key: '3/u-103' },
    ]);
  });

  it('leaves a record with no label pending, and skips it once 24 hours have passed', async () => {
    await record({ appealId: 1, imageId: 101, removalLabel: null, hoursAgo: 23.9 });
    await record({ appealId: 2, imageId: 102, removalLabel: null, hoursAgo: 24.1 });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(noLabels).toHaveBeenCalledWith([101]);
    expect(store.copy).not.toHaveBeenCalled();
    expect((await states()).map((r) => r.state)).toEqual([null, 'skipped']);
  });

  it('skips a copyable record the job reaches only after 24 hours', async () => {
    await record({ appealId: 1, imageId: 101, hoursAgo: 23.9 });
    await record({ appealId: 2, imageId: 102, hoursAgo: 24.1 });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).toHaveBeenCalledExactlyOnceWith('u-101', '1/u-101');
    expect((await states()).map((r) => r.state)).toEqual(['copied', 'skipped']);
  });

  it('reports what it did', async () => {
    await record({ appealId: 1, imageId: 101, removalLabel: null, hoursAgo: 0.5 });
    await record({ appealId: 2, imageId: 102, hoursAgo: 0.4 });
    await record({ appealId: 3, imageId: 103, removalLabel: 'minor' });
    await record({ appealId: 4, imageId: 104, hoursAgo: 0.3 });
    await record({ appealId: 5, imageId: 105, hoursAgo: 0.2 });
    const store = fakeStore();
    store.copy.mockRejectedValueOnce(new Error('NoSuchKey'));
    store.copy.mockResolvedValueOnce(undefined);
    store.copy.mockImplementationOnce(async () => {
      await holder.db.exec('DELETE FROM "AppealDecisionRecord" WHERE "appealId" = 4');
    });
    const lookup = vi.fn<RemovalLabelLookup>(
      async () => new Map([[101, { label: 'spam', nsfw: null }]])
    );

    expect(await copyRejectedForTraining({ store, lookup })).toEqual({
      configured: true,
      labelled: 1,
      copied: 2,
      discarded: 1,
      skipped: 1,
      failed: 1,
    });
  });

  it('queues the copy for deletion when recording it fails', async () => {
    await record({ appealId: 1, imageId: 101 });
    const store = fakeStore();
    const original = dbMock.dbWrite.$executeRaw.getMockImplementation()!;
    vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      strings.join('').includes(`"trainingCopyState" = 'copied'`)
        ? Promise.reject(new Error('connection reset'))
        : original(strings, ...values)) as never);

    try {
      await copyRejectedForTraining({ store, lookup: noLabels });
    } finally {
      vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(original);
    }

    expect(store.copy).toHaveBeenCalledOnce();
    expect(await states()).toEqual([
      { appealId: 1, removalLabel: 'spam', state: 'failed', key: null },
    ]);
    expect(await tombstones()).toEqual(['1/u-101']);
  });

  it('restarts the deletion grace for a key it copies again', async () => {
    await record({ appealId: 1, imageId: 101 });
    await holder.db.exec(`
      INSERT INTO "AppealTrainingObjectDeletion" (key, "createdAt")
      VALUES ('1/u-101', now() - interval '2 hours')
    `);
    const store = fakeStore();
    let fresh: unknown[] = [];
    store.copy.mockImplementationOnce(async () => {
      fresh = (
        await holder.db.query(
          `SELECT key FROM "AppealTrainingObjectDeletion" WHERE "createdAt" > now() - interval '1 hour'`
        )
      ).rows;
    });

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(fresh).toEqual([{ key: '1/u-101' }]);
  });

  it('copies newer records while older ones wait for a label', async () => {
    await holder.db.exec(`
      INSERT INTO "AppealDecisionRecord" ("appealId", "imageId", "imageUrl", "nsfwLevel", "nsfwLevelLocked",
        "decision", "decidedAt")
      SELECT g, g, 'w-' || g, 32, true, 'Rejected', now() - interval '2 hours'
      FROM generate_series(1000, 1250) g;
    `);
    await record({ appealId: 1, imageId: 101 });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).toHaveBeenCalledExactlyOnceWith('u-101', '1/u-101');
  });

  it('marks a failed copy and carries on with the rest', async () => {
    await record({ appealId: 1, imageId: 101 });
    await record({ appealId: 2, imageId: 102 });
    const store = fakeStore();
    store.copy.mockRejectedValueOnce(new Error('NoSuchKey'));

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect((await states()).map((r) => [r.state, r.key])).toEqual([
      ['failed', null],
      ['copied', '2/u-102'],
    ]);
  });

  it('leaves approvals and settled records alone', async () => {
    await record({ appealId: 1, imageId: 101, decision: 'Approved' });
    await record({ appealId: 2, imageId: 102, state: 'failed' });
    await record({ appealId: 3, imageId: 103, state: 'copied', key: 'k-103' });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).not.toHaveBeenCalled();
    expect((await states()).map((r) => r.state)).toEqual([null, 'failed', 'copied']);
  });

  it('records a keyed hash of the image owner with the copy', async () => {
    await record({ appealId: 1, imageId: 101, userId: 9 });

    await copyRejectedForTraining({ store: fakeStore(), lookup: noLabels });

    const [row] = (
      await holder.db.query<{ ownerHash: string }>('SELECT "ownerHash" FROM "AppealDecisionRecord"')
    ).rows;
    expect(row.ownerHash).toBe(ownerHashOf(9));
    expect(row.ownerHash).not.toBe(createHash('sha256').update('9').digest('hex'));
  });

  it('fails a record whose image has no owner, without copying it', async () => {
    await holder.db.exec('ALTER TABLE "Image" ALTER COLUMN "userId" DROP NOT NULL');
    try {
      await record({ appealId: 1, imageId: 101 });
      await holder.db.exec('UPDATE "Image" SET "userId" = NULL');
      const store = fakeStore();

      await copyRejectedForTraining({ store, lookup: noLabels });

      expect(store.copy).not.toHaveBeenCalled();
      expect((await states())[0].state).toBe('failed');
    } finally {
      await holder.db.exec('DELETE FROM "Image"');
      await holder.db.exec('ALTER TABLE "Image" ALTER COLUMN "userId" SET NOT NULL');
    }
  });

  it('copies nothing without the owner hash key', async () => {
    setEnv({ APPEAL_OWNER_HASH_KEY: undefined });
    await record({ appealId: 1, imageId: 101 });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).not.toHaveBeenCalled();
    expect((await states())[0].state).toBeNull();
  });

  it('does nothing when the training bucket is not configured', async () => {
    await record({ appealId: 1, imageId: 101, removalLabel: null });
    await record({ appealId: 2, imageId: 102, hoursAgo: 30 });
    const lookup = vi.fn<RemovalLabelLookup>(
      async () => new Map([[101, { label: 'spam', nsfw: 'None' }]])
    );

    await copyRejectedForTraining({ store: null, lookup });

    expect(lookup).not.toHaveBeenCalled();
    expect(await states()).toEqual([
      { appealId: 1, removalLabel: null, state: null, key: null },
      { appealId: 2, removalLabel: 'spam', state: null, key: null },
    ]);
  });
});

describe('appealTrainingHeld', () => {
  const heldQuery = Prisma.sql`SELECT id FROM "Image" WHERE ${appealTrainingHeld(
    Prisma.raw('"Image"')
  )} ORDER BY id`;
  const held = async () =>
    (await holder.db.query<{ id: number }>(heldQuery.text, heldQuery.values)).rows.map((r) => r.id);

  it('holds a pending copyable record for 24 hours from the decision, then releases it', async () => {
    await record({ appealId: 1, imageId: 101, hoursAgo: 23.9 });
    await record({ appealId: 2, imageId: 102, hoursAgo: 24.1 });

    expect(await held()).toEqual([101]);
  });

  it('holds a pending record with no label for one hour, then releases it', async () => {
    await record({ appealId: 1, imageId: 101, removalLabel: null, hoursAgo: 0.9 });
    await record({ appealId: 2, imageId: 102, removalLabel: null, hoursAgo: 1.1 });

    expect(await held()).toEqual([101]);
  });

  it.each(SKIPPED_LABELS)('never holds a record labelled %s', async (removalLabel) => {
    await record({ appealId: 1, imageId: 101, removalLabel });

    expect(await held()).toEqual([]);
  });

  it('never holds a record whose stored object an excluded image shares', async () => {
    await record({ appealId: 1, imageId: 101 });
    await holder.db.exec(
      `INSERT INTO "Image" ("id", "userId", "url", "blockedFor") VALUES (201, 8, 'u-101', 'CSAM')`
    );

    expect(await held()).toEqual([]);
  });

  it('never holds a record the copy would skip', async () => {
    await record({ appealId: 1, imageId: 101, removalLabel: 'realisticMinorNsfw' });
    await record({ appealId: 2, imageId: 102, removalLabel: 'poi', removalNsfw: 'X' });
    await record({ appealId: 3, imageId: 103, removalLabel: 'animatedMinor' });
    await record({ appealId: 4, imageId: 104, userId: 9 });
    await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (9)`);

    expect(await held()).toEqual([]);
  });

  it('holds a rated label only at a level the copy accepts', async () => {
    await record({
      appealId: 1,
      imageId: 101,
      removalLabel: 'poi',
      removalNsfw: 'Soft',
      scanRatings: ['pg13'],
    });
    await record({ appealId: 2, imageId: 102, removalLabel: 'poi' });
    await record({ appealId: 3, imageId: 103, removalLabel: 'realPerson', removalNsfw: 'Mature' });
    await record({
      appealId: 4,
      imageId: 104,
      removalLabel: 'realPerson',
      removalNsfw: 'None',
      aiNsfwLevel: 1,
    });
    await record({
      appealId: 5,
      imageId: 105,
      removalLabel: 'poi',
      removalNsfw: 'Soft',
      scanRatings: ['r'],
    });

    expect(await held()).toEqual([101]);
  });

  it('releases a record once it is copied, skipped or failed, and never holds an approval', async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: 'k' });
    await record({ appealId: 2, imageId: 102, state: 'skipped' });
    await record({ appealId: 3, imageId: 103, state: 'failed' });
    await record({ appealId: 4, imageId: 104, decision: 'Approved' });
    await record({ appealId: 5, imageId: 105 });

    expect(await held()).toEqual([105]);
  });
});

describe('sweepExcludedRecords and the training bucket', () => {
  it('deletes the objects of swept and expired records, after the records', async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: 'k-101' });
    await record({ appealId: 2, imageId: 102, state: 'copied', key: 'k-102' });
    await record({ appealId: 3, imageId: 103, state: 'skipped' });
    await holder.db.exec(`
      UPDATE "AppealDecisionRecord" SET "createdAt" = now() - interval '3 years' WHERE "appealId" = 2;
      INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 101}, {"id": 103}]');
    `);
    const store = fakeStore();

    expect(await sweepExcludedRecords(store)).toEqual({
      swept: 2,
      labels: 0,
      expired: 1,
      objects: 2,
    });
    expect(store.remove).toHaveBeenCalledExactlyOnceWith(['k-101', 'k-102']);
  });

  it('still deletes the records when an object delete fails', async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: 'k-101' });
    await holder.db.exec(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 101}]')`);
    const store = fakeStore();
    store.remove.mockRejectedValueOnce(new Error('denied'));

    expect(await sweepExcludedRecords(store)).toEqual({
      swept: 1,
      labels: 0,
      expired: 0,
      objects: 0,
    });
    expect(await states()).toEqual([]);
  });

  it('deletes a record whose stored object an excluded image shares, and its copy', async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: 'k-101' });
    await record({ appealId: 2, imageId: 102, state: 'copied', key: 'k-102' });
    await holder.db.exec(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 201}]')`);
    await holder.db.exec(`INSERT INTO "Image" ("id", "userId", "url") VALUES (201, 8, 'u-101')`);
    const store = fakeStore();

    expect((await sweepExcludedRecords(store)).swept).toBe(1);
    expect((await states()).map((row) => row.appealId)).toEqual([2]);
    expect(store.remove).toHaveBeenCalledExactlyOnceWith(['k-101']);
  });

  it('retries a failed object delete on the next sweep', async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: 'k-101' });
    await holder.db.exec(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 101}]')`);
    const store = fakeStore();
    store.remove.mockRejectedValueOnce(new Error('denied'));

    await sweepExcludedRecords(store);
    expect(await tombstones()).toEqual(['k-101']);
    await holder.db.exec(
      `UPDATE "AppealTrainingObjectDeletion" SET "createdAt" = now() - interval '2 hours'`
    );

    expect((await sweepExcludedRecords(store)).objects).toBe(1);
    expect(store.remove).toHaveBeenLastCalledWith(['k-101']);
    expect(await tombstones()).toEqual([]);
  });

  it('leaves a queued key alone for an hour, in case its copy is still running', async () => {
    await holder.db.exec(`INSERT INTO "AppealTrainingObjectDeletion" (key) VALUES ('k-new')`);
    const store = fakeStore();

    expect((await sweepExcludedRecords(store)).objects).toBe(0);
    expect(store.remove).not.toHaveBeenCalled();
    expect(await tombstones()).toEqual(['k-new']);
  });

  it('drops a queued key a record holds, without deleting the object', async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: 'k-101' });
    await holder.db.exec(`INSERT INTO "AppealTrainingObjectDeletion" (key) VALUES ('k-101')`);
    await holder.db.exec(
      `UPDATE "AppealTrainingObjectDeletion" SET "createdAt" = now() - interval '2 hours'`
    );
    const store = fakeStore();

    await sweepExcludedRecords(store);

    expect(store.remove).not.toHaveBeenCalled();
    expect(await tombstones()).toEqual([]);
  });

  it('keeps one queue entry for a key that fails twice, and deletes a key once', async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: 'k-101' });
    await holder.db.exec(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 101}]')`);
    const store = fakeStore();
    store.remove.mockRejectedValue(new Error('denied'));
    await sweepExcludedRecords(store);
    await holder.db.exec(
      `UPDATE "AppealTrainingObjectDeletion" SET "createdAt" = now() - interval '2 hours'`
    );
    await sweepExcludedRecords(store);
    expect(await tombstones()).toEqual(['k-101']);

    await record({ appealId: 2, imageId: 102, state: 'copied', key: 'k-101' });
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 102`);
    await holder.db.exec(
      `UPDATE "AppealTrainingObjectDeletion" SET "createdAt" = now() - interval '2 hours'`
    );
    store.remove.mockReset().mockResolvedValue(undefined);

    await sweepExcludedRecords(store);

    expect(store.remove).toHaveBeenCalledExactlyOnceWith(['k-101']);
    expect(await tombstones()).toEqual([]);
  });

  it("deletes only the removed record's copy when two records share an image", async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: '1/u-101' });
    await record({ appealId: 2, imageId: 101, state: 'copied', key: '2/u-101' });
    await holder.db.exec(
      `UPDATE "AppealDecisionRecord" SET "createdAt" = now() - interval '3 years' WHERE "appealId" = 1`
    );
    const store = fakeStore();

    await sweepExcludedRecords(store);

    expect(store.remove).toHaveBeenCalledExactlyOnceWith(['1/u-101']);
    expect((await states()).map((row) => [row.appealId, row.key])).toEqual([[2, '2/u-101']]);
  });

  it('queues the objects when the training bucket is not configured', async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: 'k-101' });
    await holder.db.exec(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 101}]')`);

    await sweepExcludedRecords(null);

    expect(await states()).toEqual([]);
    expect(await tombstones()).toEqual(['k-101']);
  });

  it('deletes a copied record, and its copy, when its owner is reported after the image is gone', async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: 'k-101', withImage: false });
    await record({ appealId: 2, imageId: 102, state: 'copied', key: 'k-102', withImage: false });
    await holder.db.query(
      'UPDATE "AppealDecisionRecord" SET "ownerHash" = $1 WHERE "appealId" = 1',
      [ownerHashOf(9)]
    );
    await holder.db.query(
      'UPDATE "AppealDecisionRecord" SET "ownerHash" = $1 WHERE "appealId" = 2',
      [ownerHashOf(10)]
    );
    await holder.db.exec('INSERT INTO "CsamReport" ("userId") VALUES (9)');
    const store = fakeStore();

    expect((await sweepExcludedRecords(store)).swept).toBe(1);
    expect((await states()).map((row) => row.appealId)).toEqual([2]);
    expect(store.remove).toHaveBeenCalledExactlyOnceWith(['k-101']);
  });

  it('does not call the bucket when nothing swept had an object', async () => {
    await record({ appealId: 1, imageId: 101, state: 'skipped' });
    await holder.db.exec(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 101}]')`);
    const store = fakeStore();

    expect((await sweepExcludedRecords(store)).swept).toBe(1);
    expect(store.remove).not.toHaveBeenCalled();
  });
});

describe('records removed on erasure or on request', () => {
  const appeal = (id: number, userId: number) =>
    holder.db.query(
      `INSERT INTO "Appeal" ("id", "userId", "entityType", "entityId") VALUES ($1, $2, 'Image', $1)`,
      [id, userId]
    );
  const modActivity = (entityType: string, entityId: number, activity: string) =>
    holder.db.query(
      'INSERT INTO "ModActivity" ("userId", "entityType", "entityId", activity) VALUES (1, $1, $2, $3)',
      [entityType, entityId, activity]
    );
  const ownedRecord = async (appealId: number, userId: number) => {
    await record({
      appealId,
      imageId: 100 + appealId,
      state: 'copied',
      key: `k-${appealId}`,
      userId,
    });
    await appeal(appealId, userId);
  };
  const removedKeys = (store: ReturnType<typeof fakeStore>) =>
    store.remove.mock.calls.flatMap(([keys]) => keys).sort();
  const deletedUser = (id: number, daysAgo: number | null, imageRemoval?: 'grace' | 'immediate') =>
    holder.db.query(
      `INSERT INTO "User" ("id", "deletedAt", "meta") VALUES ($1, now() - make_interval(days => $2), $3)`,
      [id, daysAgo, JSON.stringify({ imageRemoval })]
    );

  it("deletes an erased account's records and copies, and keeps another account's", async () => {
    await ownedRecord(1, 9);
    await ownedRecord(2, 10);
    await deletedUser(9, 0, 'immediate');
    await modActivity('user', 9, 'deleteAccount');
    const store = fakeStore();

    expect((await sweepExcludedRecords(store)).swept).toBe(1);
    expect((await states()).map((row) => row.appealId)).toEqual([2]);
    expect(removedKeys(store)).toEqual(['k-1']);
  });

  it('waits out the grace a restore can undo, and keeps a restored account', async () => {
    await ownedRecord(1, 9);
    await ownedRecord(2, 10);
    await ownedRecord(3, 11);
    await ownedRecord(4, 12);
    await ownedRecord(5, 13);
    await ownedRecord(6, 14);
    await deletedUser(9, 2, 'grace'); // inside the grace
    await deletedUser(10, null, 'grace'); // restored: no deletedAt
    await deletedUser(11, 8, 'grace'); // past the grace
    await deletedUser(12, 0, 'immediate');
    await deletedUser(13, null, 'immediate'); // restored, meta still naming the old removal
    await deletedUser(14, 0); // no choice recorded: immediate, as for the account's images
    for (const id of [9, 10, 11, 12, 13, 14]) await modActivity('user', id, 'deleteAccount');
    const store = fakeStore();

    expect((await sweepExcludedRecords(store)).swept).toBe(3);
    expect((await states()).map((row) => row.appealId)).toEqual([1, 2, 5]);
    expect(removedKeys(store)).toEqual(['k-3', 'k-4', 'k-6']);
  });

  it('keeps the records of an account that was deleted any other way', async () => {
    await ownedRecord(1, 9);
    await modActivity('user', 9, 'removeContent');
    await modActivity('image', 9, 'deleteAccount');

    expect((await sweepExcludedRecords(fakeStore())).swept).toBe(0);
    expect((await states()).map((row) => row.appealId)).toEqual([1]);
  });

  it('finds an erased account by owner hash when its appeal row is gone', async () => {
    await record({ appealId: 1, imageId: 101, state: 'copied', key: 'k-1', withImage: false });
    await record({ appealId: 2, imageId: 102, state: 'copied', key: 'k-2', withImage: false });
    await holder.db.query(
      'UPDATE "AppealDecisionRecord" SET "ownerHash" = $1 WHERE "appealId" = 1',
      [ownerHashOf(9)]
    );
    await holder.db.query(
      'UPDATE "AppealDecisionRecord" SET "ownerHash" = $1 WHERE "appealId" = 2',
      [ownerHashOf(10)]
    );
    await modActivity('user', 9, 'deleteAccount');
    const store = fakeStore();

    expect((await sweepExcludedRecords(store)).swept).toBe(1);
    expect((await states()).map((row) => row.appealId)).toEqual([2]);
    expect(removedKeys(store)).toEqual(['k-1']);
  });

  it('deletes the records of an image removed on a likeness request, never a realPerson removal', async () => {
    await record({
      appealId: 1,
      imageId: 101,
      removalLabel: 'realPerson',
      state: 'copied',
      key: 'k-1',
    });
    await record({
      appealId: 2,
      imageId: 102,
      removalLabel: 'realPerson',
      state: 'copied',
      key: 'k-2',
    });
    await record({
      appealId: 3,
      imageId: 103,
      removalLabel: 'likenessRequest',
      state: 'copied',
      key: 'k-3',
    });
    await modActivity('image', 102, 'likenessRequest');
    // Same id, other entity: a user 101 marked so must not reach image 101.
    await modActivity('user', 101, 'likenessRequest');
    const store = fakeStore();

    expect((await sweepExcludedRecords(store)).swept).toBe(2);
    expect((await states()).map((row) => row.appealId)).toEqual([1]);
    expect(removedKeys(store)).toEqual(['k-2', 'k-3']);
  });

  it("removes an erased account's records on the endpoint's call, rows before objects", async () => {
    await ownedRecord(1, 9);
    await ownedRecord(2, 10);
    const store = fakeStore();
    let recordsWhenObjectsWent: number[] = [];
    store.remove.mockImplementationOnce(async () => {
      recordsWhenObjectsWent = (await states()).map((row) => row.appealId);
    });

    expect(await removeErasedOwnerRecords(9, store)).toEqual({ removed: 1, objects: 1 });
    expect(recordsWhenObjectsWent).toEqual([2]);
    expect(removedKeys(store)).toEqual(['k-1']);
  });

  it('keeps the rows deleted and queues the copy when the object delete fails', async () => {
    await ownedRecord(1, 9);
    const store = fakeStore();
    store.remove.mockRejectedValueOnce(new Error('denied'));

    expect(await removeErasedOwnerRecords(9, store)).toEqual({ removed: 1, objects: 0 });
    expect(await states()).toEqual([]);
    expect(await tombstones()).toEqual(['k-1']);
    // The key names the appeal and image: logged hashed, beside the owner hash.
    const [logged, ...more] = vi.mocked(loggingMock.logToAxiom).mock.calls.map(([entry]) => entry);
    expect(more).toEqual([]);
    expect(logged).toMatchObject({
      message: expect.stringContaining(`(owner ${ownerHashOf(9)})`),
      details: { keys: [expect.stringMatching(/^[0-9a-f]{16}$/)] },
    });
    expect(JSON.stringify(logged)).not.toContain('k-1');
  });

  it('logs no raw key when the failure message names one', async () => {
    await ownedRecord(1, 9);
    const store = fakeStore();
    store.remove.mockRejectedValueOnce(new Error('delete failed: k-1'));

    await removeErasedOwnerRecords(9, store);

    const logged = vi.mocked(loggingMock.logToAxiom).mock.calls.map(([entry]) => entry);
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged)).not.toContain('k-1');
    expect(logged[0]).toMatchObject({
      details: { error: expect.stringMatching(/^delete failed: [0-9a-f]{16}$/) },
    });
  });
});

describe('createAppealTrainingStore', () => {
  const clients = () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const body = { transformToByteArray: vi.fn(async () => bytes) };
    const source = {
      send: vi.fn<(cmd: { input: unknown }) => Promise<unknown>>(async () => ({
        Body: body,
        ContentType: 'image/jpeg',
        ContentLength: 3,
      })),
    };
    const target = { send: vi.fn<(cmd: { input: unknown }) => Promise<unknown>>(async () => ({})) };
    return { bytes, source, target };
  };

  it('reads the original from the image bucket and writes it under the same key', async () => {
    const { bytes, source, target } = clients();
    const store = createAppealTrainingStore({
      source: source as never,
      sourceBucket: 'images',
      target: target as never,
      targetBucket: 'training',
    });

    await store.copy('abc-uuid', 'k-1');

    expect(source.send.mock.calls.map(([c]) => [c.constructor.name, c.input])).toEqual([
      ['GetObjectCommand', { Bucket: 'images', Key: 'abc-uuid' }],
    ]);
    expect(target.send.mock.calls.map(([c]) => [c.constructor.name, c.input])).toEqual([
      [
        'PutObjectCommand',
        {
          Bucket: 'training',
          Key: 'k-1',
          Body: bytes,
          ContentType: 'image/jpeg',
        },
      ],
    ]);
  });

  it('deletes in requests of at most 1000 keys, and throws on a failure in any of them', async () => {
    const { source, target } = clients();
    target.send
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Errors: [{ Key: 'k-1500' }] } as never)
      .mockResolvedValueOnce({});
    const store = createAppealTrainingStore({
      source: source as never,
      sourceBucket: 'images',
      target: target as never,
      targetBucket: 'training',
    });
    const keys = Array.from({ length: 2500 }, (_, i) => `k-${i}`);

    // A count, never the key: a key names its appeal and image, and the message is logged.
    const error = await store.remove(keys).catch((e: Error) => e);
    expect(error).toEqual(new Error('delete failed for 1 objects: unknown'));

    const sent = target.send.mock.calls.map(
      ([c]) => (c.input as { Delete: { Objects: { Key: string }[] } }).Delete.Objects
    );
    expect(sent.slice(0, 2).map((objects) => objects.length)).toEqual([1000, 1000]);
    expect(
      sent
        .slice(0, 2)
        .flat()
        .map((o) => o.Key)
    ).toEqual(keys.slice(0, 2000));
  });

  it('sends every key across requests', async () => {
    const { source, target } = clients();
    const store = createAppealTrainingStore({
      source: source as never,
      sourceBucket: 'images',
      target: target as never,
      targetBucket: 'training',
    });
    const keys = Array.from({ length: 2500 }, (_, i) => `k-${i}`);

    await store.remove(keys);

    const sent = target.send.mock.calls.map(
      ([c]) => (c.input as { Delete: { Objects: { Key: string }[] } }).Delete.Objects
    );
    expect(sent.map((objects) => objects.length)).toEqual([1000, 1000, 500]);
    expect(sent.flat().map((o) => o.Key)).toEqual(keys);
  });

  it('deletes from the training bucket only, and throws on a partial failure', async () => {
    const { source, target } = clients();
    target.send.mockResolvedValueOnce({ Errors: [{ Key: 'b', Code: 'AccessDenied' }] } as never);
    const store = createAppealTrainingStore({
      source: source as never,
      sourceBucket: 'images',
      target: target as never,
      targetBucket: 'training',
    });

    await expect(store.remove(['a', 'b'])).rejects.toThrow(
      new Error('delete failed for 1 objects: AccessDenied')
    );

    expect(source.send).not.toHaveBeenCalled();
    expect(target.send.mock.calls.map(([c]) => [c.constructor.name, c.input])).toEqual([
      [
        'DeleteObjectsCommand',
        { Bucket: 'training', Delete: { Objects: [{ Key: 'a' }, { Key: 'b' }], Quiet: true } },
      ],
    ]);
  });
});

describe('appealTrainingStoreFromEnv', () => {
  const full = {
    APPEAL_TRAINING_B2_BUCKET: 'training',
    APPEAL_TRAINING_B2_ACCESS_KEY: 'a',
    APPEAL_TRAINING_B2_SECRET_KEY: 's',
    S3_IMAGE_B2_ENDPOINT: 'https://b2.example',
    S3_IMAGE_B2_ACCESS_KEY: 'ia',
    S3_IMAGE_B2_SECRET_KEY: 'is',
    APPEAL_OWNER_HASH_KEY: OWNER_KEY,
  };
  const extra = { S3_IMAGE_B2_BUCKET: 'images', S3_IMAGE_B2_REGION: 'eu-central-003' };

  it('reads with the image key and writes with the training key, to the training bucket', async () => {
    setEnv({ ...full, ...extra });
    const sent: unknown[] = [];
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(async function (this: S3Client, command: { input: unknown }) {
        const { accessKeyId, secretAccessKey } = await this.config.credentials();
        const { hostname } = await this.config.endpoint!();
        sent.push([
          command.constructor.name,
          command.input,
          accessKeyId,
          secretAccessKey,
          hostname,
          await this.config.region(),
        ]);
        return { Body: { transformToByteArray: async () => new Uint8Array([1]) } };
      } as never);

    try {
      await (await appealTrainingStoreFromEnv())!.copy('k', '9/k');
    } finally {
      send.mockRestore();
    }

    expect(sent).toEqual([
      [
        'GetObjectCommand',
        { Bucket: 'images', Key: 'k' },
        'ia',
        'is',
        'b2.example',
        'eu-central-003',
      ],
      [
        'PutObjectCommand',
        { Bucket: 'training', Key: '9/k', Body: new Uint8Array([1]), ContentType: undefined },
        'a',
        's',
        'b2.example',
        'eu-central-003',
      ],
    ]);
  });

  it('is configured only when every value is set', async () => {
    setEnv({ ...full, ...extra });
    expect(isAppealTrainingConfigured()).toBe(true);
    expect(await appealTrainingStoreFromEnv()).not.toBeNull();

    for (const key of Object.keys(full)) {
      setEnv({ ...full, [key]: undefined });
      expect(isAppealTrainingConfigured(), key).toBe(false);
      if (key !== 'APPEAL_OWNER_HASH_KEY')
        expect(await appealTrainingStoreFromEnv(), key).toBeNull();
    }
  });

  it('still deletes training objects without the owner hash key', async () => {
    setEnv({ ...full, ...extra, APPEAL_OWNER_HASH_KEY: undefined });
    expect(await appealTrainingStoreFromEnv()).not.toBeNull();
  });
});

describe('community downvotes and the scanner rating', () => {
  const downvote = async (imageId: number, name: string) =>
    holder.db.query(
      `INSERT INTO "TagsOnImageVote" ("imageId", "tagId", "userId", "vote")
       SELECT $1, id, 9, -1 FROM "Tag" WHERE name = $2`,
      [imageId, name]
    );
  const tagsOf = async (imageId: number) =>
    (
      await holder.db.query<{ name: string }>(
        `SELECT t.name FROM "TagsOnImageNew" ti JOIN "Tag" t ON t.id = ti."tagId"
         WHERE ti."imageId" = $1 ORDER BY t.name`,
        [imageId]
      )
    ).rows.map((row) => row.name);

  it('never deletes a scanner rating, so a record the scan rated R stays skipped', async () => {
    await record({
      appealId: 1,
      imageId: 101,
      removalLabel: 'realPerson',
      removalNsfw: 'None',
      scanRatings: ['pg', 'r'],
    });
    await tagImage(101, 'woman', WD14_TAG_ATTRIBUTES);
    await downvote(101, 'r');
    await downvote(101, 'woman');

    // What the vote job deletes, deleted as its write does.
    for (const { imageId, tagId } of await downvotedTagsToDelete(new Date(0)))
      await holder.db.query(`DELETE FROM "TagsOnImageNew" WHERE "imageId" = $1 AND "tagId" = $2`, [
        imageId,
        tagId,
      ]);

    expect(await tagsOf(101)).toEqual(['pg', 'r']);
    const store = fakeStore();
    await copyRejectedForTraining({ store, lookup: noLabels });
    expect(store.copy).not.toHaveBeenCalled();
    expect((await states()).map((s) => s.state)).toEqual(['skipped']);
  });
});

describe('the scan rating under its own source code', () => {
  const copiedImages = async () => {
    const store = fakeStore();
    await copyRejectedForTraining({ store, lookup: noLabels });
    return store.copy.mock.calls.map(([key]) => key);
  };
  const realPerson = (appealId: number, imageId: number) =>
    record({ appealId, imageId, removalLabel: 'realPerson', removalNsfw: 'None' });

  it('reads a rating stored with the SpineRating code', async () => {
    await realPerson(1, 101);
    await tagImage(101, 'pg13', SPINE_CODE_RATING_ATTRIBUTES);
    await realPerson(2, 102);
    await tagImage(102, 'r', SPINE_CODE_RATING_ATTRIBUTES);

    expect(await copiedImages()).toEqual(['u-101']);
    expect((await states()).map((s) => s.state)).toEqual(['copied', 'skipped']);
  });

  it('reads a rating across both encodings, so an old pg and a new r still skip', async () => {
    await realPerson(1, 101);
    await tagImage(101, 'pg', SCAN_RATING_ATTRIBUTES);
    await tagImage(101, 'r', SPINE_CODE_RATING_ATTRIBUTES);

    expect(await copiedImages()).toEqual([]);
  });

  it('no longer reads a legacy automated source-0 label that is not a rating name', async () => {
    await record({
      appealId: 1,
      imageId: 101,
      removalLabel: 'realPerson',
      removalNsfw: 'None',
      scanRatings: ['pg'],
    });
    // A Hive or AiRecognition label written before those sources had codes: automated, source 0.
    await tagImage(101, 'woman', SCAN_RATING_ATTRIBUTES);

    expect(await copiedImages()).toEqual(['u-101']);
  });

  it('keeps a downvote off a SpineRating-coded rating, but not off a legacy non-rating label', async () => {
    await tagImage(101, 'r', SPINE_CODE_RATING_ATTRIBUTES);
    await tagImage(101, 'woman', SCAN_RATING_ATTRIBUTES);
    for (const name of ['r', 'woman'])
      await holder.db.query(
        `INSERT INTO "TagsOnImageVote" ("imageId", "tagId", "userId", "vote")
         SELECT 101, id, 9, -1 FROM "Tag" WHERE name = $1`,
        [name]
      );

    const selected = await downvotedTagsToDelete(new Date(0));
    const names = (
      await holder.db.query<{ name: string }>(`SELECT name FROM "Tag" WHERE id = ANY($1::int[])`, [
        selected.map((row) => row.tagId),
      ])
    ).rows.map((row) => row.name);
    expect(names).toEqual(['woman']);
  });
});
