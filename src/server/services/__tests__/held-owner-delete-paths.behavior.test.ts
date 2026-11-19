import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * An owner or moderator delete of a held owner's image or post keeps the image row and its stored
 * file, whichever hold applies, and takes the image off the site. Driven through the real
 * `deleteImages` (which /api/admin/delete-images and the creator-deal cleanup call) and
 * `deletePost`, whose SQL runs against the real migrations on PGlite. A deleted image's stored file
 * leaves through the `ImageStorageDelete` queue, written by the DELETE statement itself.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/prom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof PromClient>();
  return { ...actual, registerCounter: () => ({ inc: vi.fn() }) };
});
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/storage-resolver', () => ({
  resolveMediaLocation: async () => ({ backend: 'b2Image' }),
  registerMediaLocation: vi.fn(),
}));
vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
  imagesSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));

import { deleteImages } from '~/server/services/image.service';
import { deletePost } from '~/server/services/post.service';
import { imagesMetricsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { thumbnailCache, userImageVideoCountCaches } from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
const MIGRATIONS = path.resolve(
  __dirname,
  '../../../../packages/civitai-db-schema/prisma/migrations'
);
const migration = (name: string) => readFileSync(`${MIGRATIONS}/${name}/migration.sql`, 'utf8');

// One owner per hold, none of them with a hold marker.
const HOLDS = {
  'an unsent report': 2,
  'the secondary user of an unsent report': 3,
  'a report sent over a year ago, unarchived': 4,
  'an image awaiting review': 5,
  'a blocked image no sent report lists': 6,
  'an image listed in an unsent report': 7,
  'the placeholder owner': -1,
  'a hold marker': 1,
};
const PLAIN = 9;
const MODERATOR = 99;

const imageOf = (uid: number) => 1000 + uid;
const postOf = (uid: number) => 2000 + uid;
const urlOf = (uid: number) => `key-${uid}`;
const OWNERS = [...Object.values(HOLDS), PLAIN];

const BASE_SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    url text NOT NULL DEFAULT 'u',
    "postId" int,
    "nsfwLevel" int NOT NULL DEFAULT 0,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
    "needsReview" text,
    "blockedFor" text,
    metadata jsonb NOT NULL DEFAULT '{}',
    "updatedAt" timestamp(3),
    "cascadeParentId" int
  );
  CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "Post" (
    id int PRIMARY KEY,
    "userId" int NOT NULL,
    title text,
    detail text,
    "nsfwLevel" int NOT NULL DEFAULT 0,
    "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    "publishedAt" timestamp(3),
    "modelVersionId" int,
    "collectionId" int,
    metadata jsonb
  );
  ALTER TABLE "Image" ADD FOREIGN KEY ("postId") REFERENCES "Post"(id) ON DELETE SET NULL;
  CREATE TABLE "CsamReport" (
    id serial PRIMARY KEY,
    "userId" int,
    "reportSentAt" timestamp(3),
    "archivedAt" timestamp(3),
    images jsonb NOT NULL DEFAULT '[]',
    details jsonb NOT NULL DEFAULT '{}'
  );
  CREATE TABLE "AppealDecisionRecord" (
    "imageId" int NOT NULL,
    "imageUrl" text,
    "blockedFor" text,
    decision text NOT NULL,
    "decidedAt" timestamptz NOT NULL DEFAULT now(),
    "removalLabel" text,
    "removalNsfw" text,
    "aiNsfwLevel" int,
    "trainingCopyState" text
  );
  CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
  CREATE TYPE "JobQueueType" AS ENUM ('ImageStorageDelete', 'CdnAccessSync', 'UpdateNsfwLevel');
  CREATE TABLE "JobQueue" (
    "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
    data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
    UNIQUE ("entityType", "entityId", type)
  );
`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(BASE_SCHEMA);
  await holder.db.exec(migration('20261019220000_evidence_hold'));
  await holder.db.exec(migration('20261204120000_evidence_hold_image_prior_state'));
  await holder.db.exec(migration('20261227150000_evidence_hold_owner_held'));
});

const reset = () =>
  holder.db.exec(`
    SET session_replication_role = replica;
    TRUNCATE "Image", "Post", "CsamReport", "JobQueue", "EvidenceHold", "EvidenceHoldImage", "EvidenceHoldPost";
    SET session_replication_role = DEFAULT;
  `);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
  vi.spyOn(thumbnailCache, 'refresh').mockResolvedValue(undefined as never);
  // Only the statements that read or write the rows under test reach Postgres; the rest
  // (collection lookups, open reports, avatars) find nothing.
  const run = async (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = Array.isArray(strings)
      ? Prisma.sql(strings as TemplateStringsArray, ...(values as never[]))
      : (strings as Prisma.Sql);
    if (
      !/DELETE FROM "(Image|Post)"|AS deletable|"EvidenceHoldImage"|"JobQueue"|SELECT id FROM "Image" WHERE "postId"/.test(
        sql.text
      )
    )
      return [];
    return (await holder.db.query(sql.text, sql.values as unknown[])).rows;
  };
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(run as never);
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (fn: unknown) =>
    (fn as (tx: unknown) => unknown)(dbMock.dbWrite)) as never);

  await reset();
  await holder.db.exec(`
    INSERT INTO "Post" (id, "userId") SELECT 2000 + u, u FROM unnest(ARRAY[${OWNERS.join(',')}]) u;
    INSERT INTO "Image" (id, "userId", "postId", url, "nsfwLevel")
      SELECT 1000 + u, u, 2000 + u, 'key-' || u, 4 FROM unnest(ARRAY[${OWNERS.join(',')}]) u;
    INSERT INTO "EvidenceHold" ("userId", role, reason) VALUES (${
      HOLDS['a hold marker']
    }, 'manual', 'test');
    INSERT INTO "Image" (id, "userId", "needsReview") VALUES (3005, 5, 'csam');
    INSERT INTO "Image" (id, "userId", ingestion, "blockedFor") VALUES
      (3006, 6, 'Blocked', 'CSAM'), (3007, 7, 'Blocked', 'moderated');
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", images, details) VALUES
      (2, NULL, NULL, '[]', '{}'),
      (NULL, NULL, NULL, '[]', '{"secondaryUserId": "3"}'),
      (4, now() - interval '2 years', NULL, '[]', '{}'),
      (NULL, NULL, NULL, '[{"id": 3007}]', '{}');
  `);
});

async function imageRow(id: number) {
  const { rows } = await holder.db.query<{
    ingestion: string;
    blockedFor: string | null;
    nsfwLevel: number;
    postId: number | null;
  }>(`SELECT ingestion, "blockedFor", "nsfwLevel", "postId" FROM "Image" WHERE id = $1`, [id]);
  return rows[0];
}

/** The stored files queued for deletion, as `image-storage-deletes` will read them. */
async function queuedFiles() {
  const { rows } = await holder.db.query<{ entityId: number; data: unknown }>(
    `SELECT "entityId", data FROM "JobQueue" WHERE type = 'ImageStorageDelete' ORDER BY "entityId"`
  );
  return rows;
}

const KEPT_ROW = { ingestion: 'Blocked', blockedFor: 'moderated', nsfwLevel: 32, postId: null };

// The third column is the unheld image's queued file: an owner's plain delete may keep an object
// shop artwork uses, and only a moderator's delete purges every version, a moderator actor being
// enough to say so.
describe.each([
  [
    'an owner deleting their image',
    (uid: number) => deleteImages([imageOf(uid)], { actor: { id: uid, isModerator: false } }),
    { keepShopArtwork: true },
  ],
  [
    'a moderator deleting the image',
    (uid: number) => deleteImages([imageOf(uid)], { actor: { id: MODERATOR, isModerator: true } }),
    { allVersions: true },
  ],
  // What /api/admin/delete-images and the creator-deal cleanup call.
  [
    'a delete with no deleter',
    (uid: number) =>
      deleteImages([imageOf(uid)], { updatePosts: false, actor: { system: 'test' } }),
    {},
  ],
  [
    'an owner deleting the post',
    (uid: number) => deletePost({ id: postOf(uid), actor: { id: uid, isModerator: false } }),
    { keepShopArtwork: true },
  ],
  [
    'a moderator deleting the post',
    (uid: number) =>
      deletePost({
        id: postOf(uid),
        isModerator: true,
        actor: { id: MODERATOR, isModerator: true },
      }),
    { allVersions: true },
  ],
])('%s', (_, remove, queued) => {
  it.each(Object.entries(HOLDS))(
    'held by %s: the row and the file stay, off the site',
    async (__, uid) => {
      await remove(uid);
      expect(await queuedFiles()).toEqual([]);
      expect(await imageRow(imageOf(uid))).toEqual(KEPT_ROW);
      const kept = await holder.db.query(
        `SELECT "postId" FROM "EvidenceHoldImage" WHERE "imageId" = $1`,
        [imageOf(uid)]
      );
      expect(kept.rows).toEqual([{ postId: postOf(uid) }]);
    }
  );

  it('not held: the row and the file go', async () => {
    await remove(PLAIN);
    expect(await queuedFiles()).toEqual([
      { entityId: imageOf(PLAIN), data: { url: urlOf(PLAIN), ...queued } },
    ]);
    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
  });
});

// The DELETE and its queue writes are one statement: when a queue write fails, no row went, and
// nothing that runs after a delete (search, caches) runs.
describe('deleteImages whose statement fails', () => {
  const deindexed = () =>
    vi
      .mocked(imagesMetricsSearchIndex.queueUpdate)
      .mock.calls.flatMap(([items]) => items as { id: number; action: string }[])
      .filter((item) => item.action === SearchIndexUpdateQueueAction.Delete)
      .map((item) => item.id);

  // Its post's recount insert fails, after the row's DELETE and its file's insert in the same
  // statement: none of the three may stand.
  it('leaves the row, queues nothing, and leaves search and caches alone', async () => {
    await holder.db.exec(`
      CREATE FUNCTION refuse_recount() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type = 'UpdateNsfwLevel' THEN RAISE EXCEPTION 'queue unavailable'; END IF;
      RETURN NEW; END $$;
      CREATE TRIGGER refuse_recount BEFORE INSERT ON "JobQueue"
        FOR EACH ROW EXECUTE FUNCTION refuse_recount();
    `);
    try {
      await expect(deleteImages([imageOf(PLAIN)], { actor: { system: 'test' } })).rejects.toThrow(
        'queue unavailable'
      );
    } finally {
      await holder.db.exec(`
        DROP TRIGGER refuse_recount ON "JobQueue"; DROP FUNCTION refuse_recount();
      `);
    }

    expect(await imageRow(imageOf(PLAIN))).toBeDefined();
    expect((await holder.db.query(`SELECT type FROM "JobQueue"`)).rows).toEqual([]);
    expect(deindexed()).toEqual([]);
    expect(userImageVideoCountCaches.bust).not.toHaveBeenCalled();
  });

  it('control: the same delete that succeeds leaves search and busts its owner', async () => {
    await deleteImages([imageOf(PLAIN)], { actor: { system: 'test' } });

    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(deindexed()).toEqual([imageOf(PLAIN)]);
    expect(userImageVideoCountCaches.bust).toHaveBeenCalledWith([PLAIN]);
  });
});

// An owner deleting their own scanned, unblocked, unflagged, unreported image may leave an object
// that shop artwork still uses; any other state purges it. Every state is covered through
// `deleteImages` in moderation-blob-retraction.test.ts; these pin that `deletePost` hands over the
// reported images.
describe('an owner deleting their post keeps shop artwork only for a plain image', () => {
  const ownerDelete = () =>
    deletePost({ id: postOf(PLAIN), actor: { id: PLAIN, isModerator: false } });
  const reportLookup = (answer: () => unknown) => {
    const base = vi.mocked(dbMock.dbWrite.$queryRaw).getMockImplementation() as (
      ...args: unknown[]
    ) => unknown;
    vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(((
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) =>
      Array.from(strings).join('?').includes('"ImageReport"')
        ? Promise.resolve().then(answer)
        : base(strings, ...values)) as never);
  };

  it('purges an image under an open report', async () => {
    reportLookup(() => [{ imageId: imageOf(PLAIN) }]);
    await ownerDelete();
    expect(await queuedFiles()).toEqual([
      { entityId: imageOf(PLAIN), data: { url: urlOf(PLAIN) } },
    ]);
  });

  it('control: keeps it for a plain image no report names', async () => {
    reportLookup(() => [{ imageId: imageOf(HOLDS['an unsent report']) }]);
    await ownerDelete();
    expect(await queuedFiles()).toEqual([
      { entityId: imageOf(PLAIN), data: { url: urlOf(PLAIN), keepShopArtwork: true } },
    ]);
  });
});

// The member limit lives in the shared delete; these pin that each service hands it the actor.
describe("a member deleting another member's content", () => {
  const STRANGER = { id: 4242, isModerator: false };
  const postRow = async (id: number) =>
    (await holder.db.query(`SELECT id FROM "Post" WHERE id = $1`, [id])).rows[0];

  it.each([
    ['deleteImages', () => deleteImages([imageOf(PLAIN)], { actor: STRANGER })],
    ['deletePost', () => deletePost({ id: postOf(PLAIN), actor: STRANGER })],
  ])('%s leaves the row and the file', async (_, remove) => {
    await remove();
    expect(await queuedFiles()).toEqual([]);
    expect(await imageRow(imageOf(PLAIN))).toBeDefined();
    expect(await postRow(postOf(PLAIN))).toBeDefined();
  });
});
