import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
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
dbMock.dbWrite.$queryRaw.mockImplementation(((...a: Parameters<Raw['queryRaw']>) =>
  pgliteRaw(holder.db).queryRaw(...a)) as never);

const {
  appealTrainingHeld,
  appealTrainingStoreFromEnv,
  copyRejectedForTraining,
  createAppealTrainingStore,
  sweepExcludedRecords,
} = await import('~/server/jobs/appeal-decision-records');

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
    CREATE TABLE training_labels (
      url text, label text, "createdAt" timestamp, source text, reason text, old_label text
    );
  `);
  for (const file of MIGRATIONS) await holder.db.exec(readFileSync(file, 'utf8'));
});

beforeEach(async () => {
  vi.mocked(loggingMock.logToAxiom).mockClear();
  noLabels.mockClear();
  await holder.db.exec(
    `TRUNCATE "AppealDecisionRecord", "Image", "CsamReport", training_labels RESTART IDENTITY`
  );
});

type Rec = {
  appealId: number;
  imageId: number;
  decision?: 'Approved' | 'Rejected';
  removalLabel?: string | null;
  removalNsfw?: string | null;
  aiNsfwLevel?: number | null;
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
  copy: vi.fn(async (imageUrl: string) => `copied/${imageUrl}`),
  remove: vi.fn<(keys: string[]) => Promise<void>>(async () => undefined),
});
const noLabels = vi.fn(async () => new Map<number, Removal>());

describe('copyRejectedForTraining', () => {
  it('copies a rejected image with a copyable label and records the object key', async () => {
    await record({ appealId: 1, imageId: 101 });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).toHaveBeenCalledExactlyOnceWith('u-101');
    expect(await states()).toEqual([
      { appealId: 1, removalLabel: 'spam', state: 'copied', key: 'copied/u-101' },
    ]);
  });

  it.each([
    'minor',
    'animatedMinorNsfw',
    'realisticMinorNsfw',
    'realisticMinor',
    'schoolNsfw',
    'minorViolence',
    'diaper',
    'realPersonNsfw',
    'non-ai',
    'someNewMinorLabel',
  ])('skips, and never copies, a record labelled %s', async (removalLabel) => {
    await record({ appealId: 1, imageId: 101, removalLabel });
    const store = fakeStore();

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect(store.copy).not.toHaveBeenCalled();
    expect(await states()).toEqual([{ appealId: 1, removalLabel, state: 'skipped', key: null }]);
  });

  it.each([
    ['poi', 'None', 0, 'copied'],
    ['poi', 'Soft', 2, 'copied'],
    ['realPerson', 'None', null, 'copied'],
    ['poi', 'Mature', 0, 'skipped'],
    ['poi', 'X', 0, 'skipped'],
    ['poi', null, 0, 'skipped'],
    ['poi', 'None', 4, 'skipped'],
    ['realPerson', 'Blocked', 1, 'skipped'],
    ['realPersonNsfw', 'None', 1, 'skipped'],
  ])(
    'rates a record labelled %s at %s (ai level %s): %s',
    async (removalLabel, removalNsfw, aiNsfwLevel, state) => {
      await record({ appealId: 1, imageId: 101, removalLabel, removalNsfw, aiNsfwLevel });
      const store = fakeStore();

      await copyRejectedForTraining({ store, lookup: noLabels });

      expect(store.copy).toHaveBeenCalledTimes(state === 'copied' ? 1 : 0);
      expect((await states())[0].state).toBe(state);
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
    await record({ appealId: 3, imageId: 103, removalLabel: null });
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
    expect(store.copy.mock.calls).toEqual([['u-101'], ['u-103']]);
    expect(await states()).toEqual([
      { appealId: 1, removalLabel: 'spam', state: 'copied', key: 'copied/u-101' },
      { appealId: 2, removalLabel: 'realisticMinorNsfw', state: 'skipped', key: null },
      { appealId: 3, removalLabel: 'poi', state: 'copied', key: 'copied/u-103' },
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

    expect(store.copy).toHaveBeenCalledExactlyOnceWith('u-101');
    expect((await states()).map((r) => r.state)).toEqual(['copied', 'skipped']);
  });

  it('marks a failed copy and carries on with the rest', async () => {
    await record({ appealId: 1, imageId: 101 });
    await record({ appealId: 2, imageId: 102 });
    const store = fakeStore();
    store.copy.mockRejectedValueOnce(new Error('NoSuchKey'));

    await copyRejectedForTraining({ store, lookup: noLabels });

    expect((await states()).map((r) => [r.state, r.key])).toEqual([
      ['failed', null],
      ['copied', 'copied/u-102'],
    ]);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'appeal-training-copy' })
    );
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

  it('does nothing but warn when the training bucket is not configured', async () => {
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
    expect(loggingMock.logToAxiom).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: 'warning', name: 'appeal-training-copy' })
    );
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

  it('never holds a record the copy would skip', async () => {
    await record({ appealId: 1, imageId: 101, removalLabel: 'realisticMinorNsfw' });
    await record({ appealId: 2, imageId: 102, removalLabel: 'poi', removalNsfw: 'X' });
    await record({ appealId: 3, imageId: 103, removalLabel: 'animatedMinor' });
    await record({ appealId: 4, imageId: 104, userId: 9 });
    await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (9)`);

    expect(await held()).toEqual([]);
  });

  it('holds a rated label only at a level the copy accepts', async () => {
    await record({ appealId: 1, imageId: 101, removalLabel: 'poi', removalNsfw: 'Soft' });
    await record({ appealId: 2, imageId: 102, removalLabel: 'poi' });
    await record({ appealId: 3, imageId: 103, removalLabel: 'realPerson', removalNsfw: 'Mature' });

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

  it('logs a failed object delete and still deletes the records', async () => {
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
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', name: 'appeal-training-copy' })
    );
  });

  it('does not call the bucket when nothing swept had an object', async () => {
    await record({ appealId: 1, imageId: 101, state: 'skipped' });
    await holder.db.exec(`INSERT INTO "CsamReport" ("images") VALUES ('[{"id": 101}]')`);
    const store = fakeStore();

    expect((await sweepExcludedRecords(store)).swept).toBe(1);
    expect(store.remove).not.toHaveBeenCalled();
  });
});

describe('createAppealTrainingStore', () => {
  const clients = () => {
    const body = { transformToByteArray: vi.fn() };
    const source = {
      send: vi.fn<(cmd: { input: unknown }) => Promise<unknown>>(async () => ({
        Body: body,
        ContentType: 'image/jpeg',
        ContentLength: 3,
      })),
    };
    const target = { send: vi.fn<(cmd: { input: unknown }) => Promise<unknown>>(async () => ({})) };
    return { body, source, target };
  };

  it('reads the original from the image bucket and writes it under the same key', async () => {
    const { body, source, target } = clients();
    const store = createAppealTrainingStore({
      source: source as never,
      sourceBucket: 'images',
      target: target as never,
      targetBucket: 'training',
    });

    expect(await store.copy('abc-uuid')).toBe('abc-uuid');

    expect(source.send.mock.calls.map(([c]) => [c.constructor.name, c.input])).toEqual([
      ['GetObjectCommand', { Bucket: 'images', Key: 'abc-uuid' }],
    ]);
    expect(target.send.mock.calls.map(([c]) => [c.constructor.name, c.input])).toEqual([
      [
        'PutObjectCommand',
        {
          Bucket: 'training',
          Key: 'abc-uuid',
          Body: body,
          ContentType: 'image/jpeg',
          ContentLength: 3,
        },
      ],
    ]);
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

    await expect(store.remove(['a', 'b'])).rejects.toThrow(/b/);

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
  };

  it('is configured only when every value is set', async () => {
    setEnv(full);
    expect(await appealTrainingStoreFromEnv()).not.toBeNull();

    for (const key of Object.keys(full)) {
      setEnv({ ...full, [key]: undefined });
      expect(await appealTrainingStoreFromEnv(), key).toBeNull();
    }
  });
});
