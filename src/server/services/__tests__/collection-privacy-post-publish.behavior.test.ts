import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisCaches from '~/server/redis/caches';
import type * as TextScanSubmit from '~/server/services/text-scan/submit';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Making a collection private hides its published posts; making it public again restores only the
 * posts that hide took down, and keeps every other key in their metadata. A post unpublished any
 * other way stays down, as does one whose owner, images or text a moderator acted on meanwhile.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/search-index', () => ({ collectionsSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  userCollectionCountCache: { refresh: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanSubmit>()),
  scanEntityInBackground: vi.fn(),
}));
vi.mock('~/server/services/job-queue.service', () => ({
  enqueueJobs: vi.fn(async () => undefined),
}));

const { upsertCollection } = await import('~/server/services/collection.service');

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const COLLECTION_ID = 10;
const OWNER = 999;
const OTHER = 501;
const BANNED = 502;
const REPORTED = 503;
const SECONDARY_REPORTED = 504;
const PUBLISHED_AT = '2025-03-04 05:06:07.123';

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TYPE "TextScanHoldStatus" AS ENUM ('Pending', 'Dismissed', 'Confirmed');
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation', 'GatherInterest', 'Deleted');
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3));
    CREATE TABLE "Model" (id int PRIMARY KEY, status "ModelStatus" NOT NULL);
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY,
      "modelId" int NOT NULL REFERENCES "Model"(id),
      status "ModelStatus" NOT NULL
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY,
      "userId" int NOT NULL REFERENCES "User"(id),
      "collectionId" int,
      "modelVersionId" int REFERENCES "ModelVersion"(id),
      "publishedAt" timestamp(3),
      metadata jsonb
    );
    CREATE TABLE "Image" (
      id serial PRIMARY KEY,
      "postId" int REFERENCES "Post"(id),
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "needsReview" text
    );
    CREATE TABLE "TextScanHold" (
      id serial PRIMARY KEY,
      "entityType" text NOT NULL,
      "entityId" int NOT NULL,
      status "TextScanHoldStatus" NOT NULL DEFAULT 'Pending'
    );
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, details jsonb NOT NULL DEFAULT '{}');
  `);
});

const runOnPglite = async (strings: TemplateStringsArray, values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  return holder.db.query(flat.text, flat.values as unknown[]);
};

// Only the post writes reach the database; everything else upsertCollection touches is mocked.
const routeRaw = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  if (!strings.join('').includes('UPDATE "Post"')) return [];
  const result = await runOnPglite(strings, values);
  return result.affectedRows ?? 0;
}) as never;

beforeEach(async () => {
  vi.clearAllMocks();
  await holder.db.exec(`
    TRUNCATE "Image", "TextScanHold", "CsamReport", "Post", "ModelVersion", "Model", "User" RESTART IDENTITY CASCADE;
    INSERT INTO "User" (id, "bannedAt") VALUES
      (${OWNER}, NULL), (${OTHER}, NULL), (${BANNED}, NULL), (${REPORTED}, NULL), (${SECONDARY_REPORTED}, NULL);
    INSERT INTO "Model" (id, status) VALUES (1, 'Published'), (2, 'Published');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES (1, 1, 'Published'), (2, 2, 'Published');
    -- Not a user id; must be ignored rather than break the lookup.
    INSERT INTO "CsamReport" ("userId", details) VALUES (NULL, '{"secondaryUserId": "n/a"}');
  `);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(routeRaw);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(routeRaw);
});

async function setRead(from: 'Public' | 'Private', to: 'Public' | 'Private') {
  dbMock.dbRead.$queryRaw.mockResolvedValue([
    {
      id: COLLECTION_ID,
      read: from,
      write: 'Private',
      userId: OWNER,
      type: 'Post',
      mode: null,
      contributorPermissions: null,
      collaborationDisabledAt: null,
    },
  ] as never);
  dbMock.dbWrite.collection.findUnique.mockResolvedValue({
    id: COLLECTION_ID,
    read: from,
    write: 'Private',
    mode: null,
    createdAt: new Date('2026-01-01'),
    image: null,
  } as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn({
      collection: { update: dbMock.dbWrite.collection.update },
      tagsOnCollection: { deleteMany: vi.fn(), createMany: vi.fn() },
    })) as never);
  dbMock.dbWrite.collection.update.mockResolvedValue({
    id: COLLECTION_ID,
    read: to,
    write: 'Private',
    userId: OWNER,
    mode: null,
    image: null,
  } as never);
  dbMock.dbWrite.collectionInvite.findMany.mockResolvedValue([] as never);

  await upsertCollection({
    input: { id: COLLECTION_ID, name: 'c', read: to, userId: OWNER, isMember: true },
  } as never);
}

async function insertPost(
  id: number,
  {
    userId = OWNER,
    publishedAt = PUBLISHED_AT as string | null,
    metadata = {} as object | null,
    modelVersionId = null as number | null,
  } = {}
) {
  await holder.db.query(
    `INSERT INTO "Post" (id, "userId", "collectionId", "modelVersionId", "publishedAt", metadata) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      userId,
      COLLECTION_ID,
      modelVersionId,
      publishedAt,
      metadata === null ? null : JSON.stringify(metadata),
    ]
  );
}

async function post(id: number) {
  // As text: the client would read a zoneless timestamp in the machine's local zone.
  const { rows } = await holder.db.query<{ publishedAt: string | null; metadata: unknown }>(
    `SELECT "publishedAt"::text AS "publishedAt", metadata FROM "Post" WHERE id = $1`,
    [id]
  );
  return rows[0];
}

const moderatorStamps = {
  unpublishedAt: '2026-05-01T00:00:00.000Z',
  unpublishedBy: 42,
  unpublishedReason: 'csam-text-hold',
  prevPublishedAt: '2025-03-04T05:06:07.123',
  keep: 'yes',
};
const modelUnpublishStamps = {
  unpublishedAt: '2026-05-01T00:00:00.000Z',
  unpublishedBy: OWNER,
  prevPublishedAt: '2025-03-04T05:06:07.123',
};

describe('collection privacy toggle and its posts', () => {
  it('hides published posts on private and restores them, exact date and metadata, on public', async () => {
    await insertPost(1, { metadata: { keep: 'x' } });
    await insertPost(2, { userId: OTHER });
    await insertPost(3, { metadata: null });

    await setRead('Public', 'Private');
    expect(await post(1)).toEqual({
      publishedAt: null,
      metadata: {
        keep: 'x',
        prevPublishedAt: '2025-03-04T05:06:07.123',
        unpublishedByCollection: COLLECTION_ID,
      },
    });
    expect((await post(3)).metadata).toEqual({
      prevPublishedAt: '2025-03-04T05:06:07.123',
      unpublishedByCollection: COLLECTION_ID,
    });

    await setRead('Private', 'Public');
    expect(await post(1)).toEqual({ publishedAt: PUBLISHED_AT, metadata: { keep: 'x' } });
    expect(await post(2)).toEqual({ publishedAt: PUBLISHED_AT, metadata: {} });
    expect(await post(3)).toEqual({ publishedAt: PUBLISHED_AT, metadata: {} });
  });

  it('leaves moderator-unpublished, model-unpublished and draft posts untouched both ways', async () => {
    await insertPost(1, { publishedAt: null, metadata: moderatorStamps });
    await insertPost(2, { userId: OTHER, publishedAt: null, metadata: modelUnpublishStamps });
    await insertPost(3, { publishedAt: null, metadata: null });
    await insertPost(4); // control: proves the public flip ran

    await setRead('Public', 'Private');
    await setRead('Private', 'Public');

    expect(await post(1)).toEqual({ publishedAt: null, metadata: moderatorStamps });
    expect(await post(2)).toEqual({ publishedAt: null, metadata: modelUnpublishStamps });
    expect(await post(3)).toEqual({ publishedAt: null, metadata: null });
    expect((await post(4)).publishedAt).toBe(PUBLISHED_AT);
  });

  it('restores a post hidden before the marker existed, unless it carries an unpublish stamp', async () => {
    await insertPost(1, {
      publishedAt: null,
      metadata: { prevPublishedAt: '2025-03-04T05:06:07.123' },
    });
    const stamped = { prevPublishedAt: '2025-03-04T05:06:07.123', unpublishedAt: '2026-05-01' };
    await insertPost(2, { publishedAt: null, metadata: stamped });

    await setRead('Private', 'Public');

    expect(await post(1)).toEqual({ publishedAt: PUBLISHED_AT, metadata: {} });
    expect(await post(2)).toEqual({ publishedAt: null, metadata: stamped });
  });

  it('restores nothing that carries a repair stamp', async () => {
    const repaired = { prevPublishedAt: '2025-03-04T05:06:07.123', repairStampAt: '2026-05-01' };
    await insertPost(1, { publishedAt: null, metadata: repaired });
    await insertPost(2, {
      publishedAt: null,
      metadata: { prevPublishedAt: '2025-03-04T05:06:07.123' },
    });

    await setRead('Private', 'Public');

    expect(await post(1)).toEqual({ publishedAt: null, metadata: repaired });
    expect((await post(2)).publishedAt).toBe(PUBLISHED_AT);
  });

  it('leaves a published post with a leftover stash alone', async () => {
    const stash = { prevPublishedAt: '2020-01-01T00:00:00' };
    await insertPost(1, { metadata: stash });

    await setRead('Private', 'Public');

    expect(await post(1)).toEqual({ publishedAt: PUBLISHED_AT, metadata: stash });
  });

  it("does not restore a post carrying another collection's marker", async () => {
    const foreign = { prevPublishedAt: '2025-03-04T05:06:07.123', unpublishedByCollection: 11 };
    await insertPost(1, { publishedAt: null, metadata: foreign });

    await setRead('Private', 'Public');

    expect(await post(1)).toEqual({ publishedAt: null, metadata: foreign });
  });

  describe('keeps a collection-hidden post down when a moderator acted while it was hidden', () => {
    const cases: [string, (postId: number) => Promise<unknown>, number?][] = [
      [
        'the owner is banned',
        () => holder.db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [BANNED]),
        BANNED,
      ],
      [
        'an image is blocked',
        (postId) =>
          holder.db.query(`INSERT INTO "Image" ("postId", ingestion) VALUES ($1, 'Blocked')`, [
            postId,
          ]),
      ],
      [
        'an image needs csam review',
        (postId) =>
          holder.db.query(`INSERT INTO "Image" ("postId", "needsReview") VALUES ($1, 'csam')`, [
            postId,
          ]),
      ],
      [
        'the post has a confirmed text-scan hold',
        (postId) =>
          holder.db.query(
            `INSERT INTO "TextScanHold" ("entityType", "entityId", status) VALUES ('Post', $1, 'Confirmed')`,
            [postId]
          ),
      ],
      [
        'the owner is on a csam report',
        () => holder.db.query(`INSERT INTO "CsamReport" ("userId") VALUES ($1)`, [REPORTED]),
        REPORTED,
      ],
      [
        'the owner is the secondary user on a csam report',
        () =>
          holder.db.query(`INSERT INTO "CsamReport" ("userId", details) VALUES (NULL, $1)`, [
            JSON.stringify({ secondaryUserId: SECONDARY_REPORTED }),
          ]),
        SECONDARY_REPORTED,
      ],
    ];

    it.each(cases)('%s', async (_name, act, userId = OWNER) => {
      await insertPost(1, { userId });
      await insertPost(2, { userId: OTHER }); // control: proves the public flip ran
      // Unrelated rows a looser match would trip on.
      await holder.db.query(`INSERT INTO "Image" ("postId", "needsReview") VALUES (2, 'minor')`);
      await holder.db.query(
        `INSERT INTO "TextScanHold" ("entityType", "entityId", status) VALUES ('Post', 2, 'Pending'), ('Image', 2, 'Confirmed')`
      );

      await setRead('Public', 'Private');
      await act(1);
      await setRead('Private', 'Public');

      expect(await post(1)).toEqual({
        publishedAt: null,
        metadata: {
          prevPublishedAt: '2025-03-04T05:06:07.123',
          unpublishedByCollection: COLLECTION_ID,
        },
      });
      expect((await post(2)).publishedAt).toBe(PUBLISHED_AT);
    });
  });

  describe('keeps a collection-hidden post down unless its model and version are both published', () => {
    it('a takedown while hidden stamps nothing, and the public flip does not undo it', async () => {
      await insertPost(1, { modelVersionId: 1 });
      await insertPost(2, { modelVersionId: 2 }); // control: published model and version

      await setRead('Public', 'Private');

      // The post cascade of the model takedown (model.service.ts, unpublishModelById): it only
      // reaches posts that are still published.
      const cascade = await holder.db.query(
        `UPDATE "Post"
         SET "metadata" = "metadata" || jsonb_build_object(
               'unpublishedAt', now()::text, 'unpublishedBy', 42, 'prevPublishedAt', "publishedAt"),
             "publishedAt" = NULL
         WHERE "publishedAt" IS NOT NULL AND "userId" = $1 AND "modelVersionId" IN (1)`,
        [OWNER]
      );
      expect(cascade.affectedRows).toBe(0);
      await holder.db.exec(`
        UPDATE "Model" SET status = 'UnpublishedViolation' WHERE id = 1;
        UPDATE "ModelVersion" SET status = 'UnpublishedViolation' WHERE id = 1;
      `);

      await setRead('Private', 'Public');

      expect(await post(1)).toEqual({
        publishedAt: null,
        metadata: {
          prevPublishedAt: '2025-03-04T05:06:07.123',
          unpublishedByCollection: COLLECTION_ID,
        },
      });
      expect((await post(2)).publishedAt).toBe(PUBLISHED_AT);
    });

    it.each([
      ['Model', 'Unpublished'],
      ['Model', 'Deleted'],
      ['Model', 'Scheduled'],
      ['ModelVersion', 'Unpublished'],
      ['ModelVersion', 'UnpublishedViolation'],
      ['ModelVersion', 'Draft'],
    ])('%s %s', async (table, status) => {
      await insertPost(1, { modelVersionId: 1 });
      await insertPost(2, { modelVersionId: 2 });

      await setRead('Public', 'Private');
      await holder.db.query(`UPDATE "${table}" SET status = $1 WHERE id = 1`, [status]);
      await setRead('Private', 'Public');

      expect((await post(1)).publishedAt).toBeNull();
      expect((await post(2)).publishedAt).toBe(PUBLISHED_AT);
    });
  });

  it('restores nothing when a guard lookup fails', async () => {
    await insertPost(1);
    await setRead('Public', 'Private');
    await holder.db.exec(`ALTER TABLE "CsamReport" RENAME TO "CsamReportGone"`);
    try {
      await expect(setRead('Private', 'Public')).rejects.toThrow();
    } finally {
      await holder.db.exec(`ALTER TABLE "CsamReportGone" RENAME TO "CsamReport"`);
    }
    expect((await post(1)).publishedAt).toBeNull();
  });
});
