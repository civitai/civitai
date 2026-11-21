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

import { deleteImages, imagesPendingDeletion } from '~/server/services/image.service';
import { deletePost } from '~/server/services/post.service';
import { pendingDeletes } from '~/server/jobs/pending-deletes';
import { imagesMetricsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { thumbnailCache, userImageVideoCountCaches } from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { queueImageDeletes } from '@civitai/db-queries/content-deletion';
import { kyselyOver } from '~/server/db/prisma-kysely';
import { BAN_NOTE_HOLD_TABLES_SQL } from '~/server/services/__tests__/ban-note-hold-tables.fixture';

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
  CREATE TYPE "JobQueueType" AS ENUM (
    'ImageStorageDelete', 'CdnAccessSync', 'UpdateNsfwLevel', 'PendingDelete'
  );
  CREATE TABLE "JobQueue" (
    "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
    data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
    UNIQUE ("entityType", "entityId", type)
  );
`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(BASE_SCHEMA);
  await holder.db.exec(imageUseTablesSql);
  await holder.db.exec(migration('20261019220000_evidence_hold'));
  await holder.db.exec(migration('20261204120000_evidence_hold_image_prior_state'));
  await holder.db.exec(migration('20261227150000_evidence_hold_owner_held'));
  await holder.db.exec(BAN_NOTE_HOLD_TABLES_SQL);
});

const reset = () =>
  holder.db.exec(`
    SET session_replication_role = replica;
    TRUNCATE "Image", "Post", "CsamReport", "JobQueue", "EvidenceHold", "EvidenceHoldImage", "EvidenceHoldPost";
    SET session_replication_role = DEFAULT;
  `);

const failingDeletes = new Set<number>();
// Posts whose text is held, as `post_text_held` would answer.
const heldTextPosts = new Set<number>();
// Runs once, before the next image DELETE: what changes while a job run is under way.
let beforeNextImageDelete: (() => Promise<unknown>) | undefined;

beforeEach(async () => {
  vi.clearAllMocks();
  failingDeletes.clear();
  heldTextPosts.clear();
  beforeNextImageDelete = undefined;
  vi.spyOn(userImageVideoCountCaches, 'bust').mockResolvedValue(undefined);
  vi.spyOn(thumbnailCache, 'refresh').mockResolvedValue(undefined as never);
  // Only the statements that read or write the rows under test reach Postgres; the rest
  // (collection lookups, open reports, avatars) find nothing.
  const run = async (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = Array.isArray(strings)
      ? Prisma.sql(strings as TemplateStringsArray, ...(values as never[]))
      : (strings as Prisma.Sql);
    if (/FROM "PostText"/.test(sql.text))
      return sql.values.filter((v) => heldTextPosts.has(v as number)).map((postId) => ({ postId }));
    if (
      !/DELETE FROM "(Image|Post)"|AS deletable|"EvidenceHoldImage"|"JobQueue"|SELECT id FROM "Image" WHERE "postId"/.test(
        sql.text
      )
    )
      return [];
    // A delete of an image in `failingDeletes` fails, as when the database drops the statement.
    if (
      /DELETE FROM "Image"/.test(sql.text) &&
      sql.values.some((v) => Array.isArray(v) && v.some((id) => failingDeletes.has(id as number)))
    )
      throw new Error('statement failed');
    if (/DELETE FROM "Image"/.test(sql.text) && beforeNextImageDelete) {
      const change = beforeNextImageDelete;
      beforeNextImageDelete = undefined;
      await change();
    }
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

const postRow = async (id: number) =>
  (await holder.db.query(`SELECT id FROM "Post" WHERE id = $1`, [id])).rows[0];

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
      Array.from(strings).join('?').includes('SELECT ir."imageId" FROM "ImageReport"')
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

describe('an owner deleting their own content in a child-safety case', () => {
  // A row due later is shown with `waiting: true` folded into its data.
  const pending = async () =>
    (
      await holder.db.query<{ entityId: number; entityType: string; data: unknown }>(
        `SELECT "entityId", "entityType"::text AS "entityType",
           CASE WHEN "createdAt" > now() THEN data || '{"waiting": true}' ELSE data END AS data
         FROM "JobQueue" WHERE type = 'PendingDelete' ORDER BY "entityType", "entityId"`
      )
    ).rows;
  const told = async (id: number) => (await imagesPendingDeletion([id])).has(id);
  const owner = { id: PLAIN, isModerator: false };
  const runJob = async () => {
    await pendingDeletes.run({} as Parameters<typeof pendingDeletes.run>[0]).result;
    // Due again at once, as when its wait is up.
    await holder.db.exec(`UPDATE "JobQueue" SET "createdAt" = now() WHERE type = 'PendingDelete'`);
  };

  beforeEach(() =>
    holder.db.exec(`TRUNCATE "Report", "PostReport", "ImageReport", "CsamQueueSetAside"`)
  );

  it('keeps the image and its file, queues the delete, and its owner is told', async () => {
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${imageOf(PLAIN)}`);

    expect(await deleteImages([imageOf(PLAIN)], { actor: owner })).toEqual([]);

    expect(await imageRow(imageOf(PLAIN))).toBeDefined();
    expect(await queuedFiles()).toEqual([]);
    expect(await pending()).toEqual([
      { entityId: imageOf(PLAIN), entityType: 'Image', data: { ownerId: PLAIN } },
    ]);
    expect(await told(imageOf(PLAIN))).toBe(true);
  });

  it('keeps a post under a child-safety report, with its images, and queues both', async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);

    // Answers like a delete: nothing says a review holds it.
    expect(await deletePost({ id: postOf(PLAIN), actor: owner })).toBeUndefined();

    expect(await imageRow(imageOf(PLAIN))).toMatchObject({ postId: postOf(PLAIN) });
    expect(await pending()).toEqual([
      { entityId: imageOf(PLAIN), entityType: 'Image', data: { ownerId: PLAIN } },
      { entityId: postOf(PLAIN), entityType: 'Post', data: { ownerId: PLAIN } },
    ]);
    // A report the owner cannot see: nothing tells them.
    expect(await told(imageOf(PLAIN))).toBe(false);
  });

  it('keeps an image under CSAM review without telling its owner, who is not shown the review', async () => {
    await holder.db.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = ${imageOf(PLAIN)}`);

    expect(await deleteImages([imageOf(PLAIN)], { actor: owner })).toEqual([]);

    expect(await pending()).toHaveLength(1);
    expect(await told(imageOf(PLAIN))).toBe(false);
  });

  it("tells the owner of a post kept over an image they see blocked, in the post delete's answer", async () => {
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${imageOf(PLAIN)}`);

    const answer = await deletePost({ id: postOf(PLAIN), actor: owner });
    expect(answer).toMatchObject({
      id: postOf(PLAIN),
      deletedImageIds: [],
      deleteAfterReview: true,
    });
  });

  it('is carried out by pending-deletes once the report is ruled on, and not before', async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1);
    `);
    await deleteImages([imageOf(PLAIN)], { actor: owner });

    await runJob();
    expect(await imageRow(imageOf(PLAIN))).toBeDefined();

    await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);
    await runJob();

    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(await pending()).toEqual([]);
    expect(await queuedFiles()).toEqual([
      { entityId: imageOf(PLAIN), data: { url: urlOf(PLAIN), keepShopArtwork: true } },
    ]);
  });

  it('carries out a kept post once its report is ruled on', async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    await deletePost({ id: postOf(PLAIN), actor: owner });

    await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);
    await runJob();

    expect(await postRow(postOf(PLAIN))).toBeUndefined();
    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(await pending()).toEqual([]);
  });

  it("doesn't hold a moderator's delete of someone else's image or post in a case", async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1);
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    const moderator = { id: MODERATOR, isModerator: true };

    expect(await deleteImages([imageOf(PLAIN)], { actor: moderator })).toHaveLength(1);
    await deletePost({ id: postOf(PLAIN), isModerator: true, actor: moderator });

    expect(await postRow(postOf(PLAIN))).toBeUndefined();
    expect(await pending()).toEqual([]);
  });

  it("is done with a pending delete whose image is gone, or is no longer the owner's", async () => {
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", url) VALUES (4002, 4242, 'key-given');
      INSERT INTO "JobQueue" ("entityId", "entityType", type, data) VALUES
        (4001, 'Image', 'PendingDelete', '{"ownerId": ${PLAIN}}'),
        (4002, 'Image', 'PendingDelete', '{"ownerId": ${PLAIN}}');
    `);

    await runJob();

    expect(await imageRow(4002)).toBeDefined();
    expect(await pending()).toEqual([]);
  });

  it('leaves a waiting delete alone until it is due', async () => {
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${imageOf(PLAIN)}`);
    await deleteImages([imageOf(PLAIN)], { actor: owner });
    const runOnce = () => pendingDeletes.run({} as Parameters<typeof pendingDeletes.run>[0]).result;

    await runOnce();
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = NULL WHERE id = ${imageOf(PLAIN)}`);
    await runOnce();
    expect(await imageRow(imageOf(PLAIN))).toBeDefined();

    await holder.db.exec(`UPDATE "JobQueue" SET "createdAt" = now() WHERE type = 'PendingDelete'`);
    await runOnce();
    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
  });

  it('keeps a delete that was blocked when the run read it, though its case closes during the run', async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1);
      INSERT INTO "Image" (id, "userId", url) VALUES (4001, ${PLAIN}, 'key-a');
    `);
    await deleteImages([imageOf(PLAIN)], { actor: owner });
    await queueImageDeletes(kyselyOver(dbMock.dbWrite as never), [4001], { ownerId: PLAIN });
    // Ruled on while the run carries out the other row.
    beforeNextImageDelete = () =>
      holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);

    await runJob();
    expect(await imageRow(4001)).toBeUndefined();
    expect(await imageRow(imageOf(PLAIN))).toBeDefined();
    expect(await pending()).toEqual([
      { entityId: imageOf(PLAIN), entityType: 'Image', data: { ownerId: PLAIN } },
    ]);

    await runJob();
    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
  });

  it("keeps an owner's post waiting while its text is held, and carries it out once released", async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    await deletePost({ id: postOf(PLAIN), actor: owner });
    await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);
    heldTextPosts.add(postOf(PLAIN));

    await runJob();
    expect(await postRow(postOf(PLAIN))).toBeDefined();
    expect((await pending()).find((row) => row.entityType === 'Post')?.data).toEqual({
      ownerId: PLAIN,
    });

    heldTextPosts.clear();
    await runJob();
    expect(await postRow(postOf(PLAIN))).toBeUndefined();
  });

  it('retries a failed delete alone on the next run, and fails no other', async () => {
    await holder.db.exec(`INSERT INTO "Image" (id, "userId", url) VALUES
      (4001, ${PLAIN}, 'key-a'), (4003, ${PLAIN}, 'key-b')`);
    await queueImageDeletes(kyselyOver(dbMock.dbWrite as never), [4001, 4003], { ownerId: PLAIN });
    failingDeletes.add(4001);

    await runJob();

    expect(await imageRow(4003)).toBeUndefined();
    expect(await imageRow(4001)).toBeDefined();
    expect(await pending()).toEqual([
      { entityId: 4001, entityType: 'Image', data: { cleanup: true, attempted: true } },
    ]);

    failingDeletes.clear();
    await runJob();
    expect(await imageRow(4001)).toBeUndefined();
  });

  it('carries out each kind of row in one run as its own kind', async () => {
    const otherOwner = 4242;
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", url) VALUES
        (4001, ${PLAIN}, 'key-a'), (4002, ${otherOwner}, 'key-b'),
        (4003, ${PLAIN}, 'key-c'), (4004, ${PLAIN}, 'key-d');
      INSERT INTO "JobQueue" ("entityId", "entityType", type, data) VALUES
        (4001, 'Image', 'PendingDelete', '{"ownerId": ${PLAIN}}'),
        (4002, 'Image', 'PendingDelete', '{"ownerId": ${otherOwner}}'),
        (4003, 'Image', 'PendingDelete', '{"cleanup": true}'),
        (4004, 'Image', 'PendingDelete', '{"cleanup": true, "moderatorDelete": true}');
    `);

    await runJob();

    for (const id of [4001, 4002, 4003, 4004]) expect(await imageRow(id)).toBeUndefined();
    expect(await pending()).toEqual([]);
    // Only the moderator's cleanup purges every version of the file.
    const files = await queuedFiles();
    expect(
      files
        .map(({ entityId, data }) => [entityId, !!(data as { allVersions?: boolean }).allVersions])
        .sort(([a], [b]) => Number(a) - Number(b))
    ).toEqual([
      [4001, false],
      [4002, false],
      [4003, false],
      [4004, true],
    ]);
  });

  // A parent's cleanup (an article delete, a replaced cover) of an image a report holds.
  describe('left behind by a cleanup', () => {
    const ORPHAN = 4009;
    const cleanup = async () => (await pending()).find((row) => row.entityId === ORPHAN)?.data;

    beforeEach(async () => {
      await holder.db.exec(`
        TRUNCATE "ImageConnection";
        INSERT INTO "Image" (id, "userId", url) VALUES (${ORPHAN}, ${PLAIN}, 'key-orphan');
        INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
        INSERT INTO "ImageReport" VALUES (${ORPHAN}, 1);
      `);
      await queueImageDeletes(kyselyOver(dbMock.dbWrite as never), [ORPHAN], { ownerId: PLAIN });
      await runJob();
      expect(await imageRow(ORPHAN)).toBeDefined();
      expect(await cleanup()).toEqual({ cleanup: true });
    });

    it('is deleted once the report is ruled on', async () => {
      await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);
      await runJob();

      expect(await imageRow(ORPHAN)).toBeUndefined();
      expect(await cleanup()).toBeUndefined();
    });

    it('stays, and its cleanup goes, when something uses it again', async () => {
      await holder.db.exec(`
        UPDATE "Report" SET status = 'Actioned' WHERE id = 1;
        INSERT INTO "ImageConnection" ("imageId") VALUES (${ORPHAN});
      `);
      await runJob();

      expect(await imageRow(ORPHAN)).toBeDefined();
      expect(await cleanup()).toBeUndefined();
    });

    it('keeps waiting while another report on it is open, and goes once that one is ruled on', async () => {
      await holder.db.exec(`
        UPDATE "Report" SET status = 'Actioned' WHERE id = 1;
        INSERT INTO "Report" (id, reason) VALUES (2, 'TOSViolation');
        INSERT INTO "ImageReport" VALUES (${ORPHAN}, 2);
      `);
      await runJob();
      expect(await imageRow(ORPHAN)).toBeDefined();
      expect(await cleanup()).toEqual({ cleanup: true });

      await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 2`);
      await runJob();
      expect(await imageRow(ORPHAN)).toBeUndefined();
    });

    it("waits as a moderator's cleanup on the child-safety report, but not on another", async () => {
      await queueImageDeletes(kyselyOver(dbMock.dbWrite as never), [ORPHAN], {
        ownerId: PLAIN,
        moderatorDelete: true,
      });
      await runJob();
      expect(await imageRow(ORPHAN)).toBeDefined();
      expect(await cleanup()).toEqual({ cleanup: true, moderatorDelete: true });

      await holder.db.exec(`
        UPDATE "Report" SET status = 'Actioned' WHERE id = 1;
        INSERT INTO "Report" (id, reason) VALUES (2, 'TOSViolation');
        INSERT INTO "ImageReport" VALUES (${ORPHAN}, 2);
      `);
      await runJob();
      expect(await imageRow(ORPHAN)).toBeUndefined();
      // Carried out as the moderator's: every version of the file goes.
      expect(await queuedFiles()).toEqual([
        { entityId: ORPHAN, data: { url: 'key-orphan', allVersions: true } },
      ]);
    });

    it("goes though in use again when its owner asked too, as the moderator's", async () => {
      await deleteImages([ORPHAN], { actor: owner });
      await queueImageDeletes(kyselyOver(dbMock.dbWrite as never), [ORPHAN], {
        ownerId: PLAIN,
        moderatorDelete: true,
      });
      await holder.db.exec(`
        INSERT INTO "ImageConnection" ("imageId") VALUES (${ORPHAN});
        UPDATE "Report" SET status = 'Actioned' WHERE id = 1;
      `);

      await runJob();

      expect(await imageRow(ORPHAN)).toBeUndefined();
      expect(await queuedFiles()).toEqual([
        { entityId: ORPHAN, data: { url: 'key-orphan', allVersions: true } },
      ]);
    });

    it('waits while its owner is held, though nothing else keeps it', async () => {
      const held = HOLDS['a hold marker'];
      await holder.db.exec(
        `INSERT INTO "Image" (id, "userId", url) VALUES (4001, ${held}, 'key-held-orphan')`
      );
      await queueImageDeletes(kyselyOver(dbMock.dbWrite as never), [4001], { ownerId: held });
      await runJob();

      expect(await imageRow(4001)).toBeDefined();
      expect((await pending()).find((row) => row.entityId === 4001)?.data).toEqual({
        cleanup: true,
      });
    });

    it('waits while its owner is banned with a note naming CSAM, and no other hold', async () => {
      const BAN_NOTE = 11;
      await holder.db.exec(`
        INSERT INTO "User" (id, meta, "bannedAt") VALUES
          (${BAN_NOTE}, '{"banDetails": {"detailsInternal": "csam"}}', now() - interval '1 day')
        ON CONFLICT DO NOTHING;
        INSERT INTO "Image" (id, "userId", url) VALUES (4002, ${BAN_NOTE}, 'key-ban-note-orphan');
      `);
      await queueImageDeletes(kyselyOver(dbMock.dbWrite as never), [4002], { ownerId: BAN_NOTE });
      await runJob();

      expect(await imageRow(4002)).toBeDefined();
    });

    it("is replaced by the owner's own delete, which then waits only on the case", async () => {
      await holder.db.exec(`INSERT INTO "ImageConnection" ("imageId") VALUES (${ORPHAN})`);
      await deleteImages([ORPHAN], { actor: owner });
      expect(await cleanup()).toEqual({ ownerId: PLAIN });

      // In use, but the owner asked: it goes once the report is ruled on.
      await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);
      await runJob();
      expect(await imageRow(ORPHAN)).toBeUndefined();
    });
  });
});
