import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as PromClient from '~/server/prom/client';

/**
 * Owner and moderator deletes of images and posts whose owner a CSAM report names or that sit in a
 * child-safety case: what is kept and queued, what goes, and how pending-deletes carries it out.
 * Driven through the real
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

import {
  deleteImages,
  imagesPendingDeletion,
  writeModeratorBlock,
} from '~/server/services/image.service';
import { deletePost } from '~/server/services/post.service';
import { pendingDeletes } from '~/server/jobs/pending-deletes';
import {
  ACCOUNT_DELETION_DRAIN,
  lockAccountDeletionPendingDeletes,
  releaseAccountDeletionPendingDeletes,
} from '~/server/services/account-deletion-images';
import { imagesMetricsSearchIndex } from '~/server/search-index';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { thumbnailCache, userImageVideoCountCaches } from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { queueImageDeletes } from '@civitai/db-queries/content-deletion';
import { kyselyOver } from '~/server/db/prisma-kysely';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

// One owner per way a report not yet sent names them.
const HOLDS = {
  'an unsent report': 2,
  'the secondary user of an unsent report': 3,
};
const PLAIN = 9;
const MODERATOR = 99;

const imageOf = (uid: number) => 1000 + uid;
const postOf = (uid: number) => 2000 + uid;
const urlOf = (uid: number) => `key-${uid}`;
const OWNERS = [...Object.values(HOLDS), PLAIN];

const BASE_SCHEMA = `
  CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp(3), "bannedAt" timestamp(3));
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
    'ImageStorageDelete', 'CdnAccessSync', 'UpdateNsfwLevel', 'PendingDelete', 'BlockedImageDelete'
  );
  CREATE TABLE "JobQueue" (
    "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
    data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
    UNIQUE ("entityType", "entityId", type)
  );
  CREATE TABLE "ServiceDealFileEntry" (id serial PRIMARY KEY, "imageId" int, "scanKey" text);
`;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(BASE_SCHEMA);
  await holder.db.exec(imageUseTablesSql);
  await holder.db.exec(
    readFileSync(
      `${__dirname}/../../../../packages/civitai-db-schema/prisma/migrations/20271203120000_image_kept_hide_marker_drop/migration.sql`,
      'utf8'
    )
  );
});

const reset = () =>
  holder.db.exec(`
    SET session_replication_role = replica;
    TRUNCATE "User", "Image", "Post", "CsamReport", "JobQueue", "ServiceDealFileEntry", "ServiceDealFile";
    SET session_replication_role = DEFAULT;
  `);

const failingDeletes = new Set<number>();
// Posts whose text is held, as `post_text_held` would answer.
const heldTextPosts = new Set<number>();
// Runs once, before the next image DELETE: what changes while a job run is under way.
let beforeNextImageDelete: (() => Promise<unknown>) | undefined;
/** Runs every statement on the database, for a caller whose writes the filter above would drop. */
let passAllSql = false;

beforeEach(async () => {
  vi.clearAllMocks();
  failingDeletes.clear();
  heldTextPosts.clear();
  beforeNextImageDelete = undefined;
  passAllSql = false;
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
      !passAllSql &&
      !/DELETE FROM "(Image|Post)"|AS deletable|AS cleared|AS found|"JobQueue"|SELECT id FROM "Image" WHERE "postId"|FROM "ServiceDealFileEntry"/.test(
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
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(run as never);
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (fn: unknown) =>
    (fn as (tx: unknown) => unknown)(dbMock.dbWrite)) as never);

  await reset();
  await holder.db.exec(`
    INSERT INTO "Post" (id, "userId") SELECT 2000 + u, u FROM unnest(ARRAY[${OWNERS.join(',')}]) u;
    INSERT INTO "Image" (id, "userId", "postId", url, "nsfwLevel")
      SELECT 1000 + u, u, 2000 + u, 'key-' || u, 4 FROM unnest(ARRAY[${OWNERS.join(',')}]) u;
    INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt", images, details) VALUES
      (2, NULL, NULL, '[]', '{}'),
      (NULL, NULL, NULL, '[]', '{"secondaryUserId": "3"}');
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
])('%s', (name, remove, queued) => {
  // An owner's own delete waits for a report not yet sent (`ownImageDeleteBlocked`): the row is
  // blocked in place until the send. Anyone else's delete runs.
  const deferred = name.startsWith('an owner');

  it.each(Object.entries(HOLDS).filter(() => deferred))(
    'held by %s: queued, blocked in place and no file queued',
    async (__, uid) => {
      const before = await imageRow(imageOf(uid));
      await remove(uid);
      expect(await queuedFiles()).toEqual([]);
      expect(await imageRow(imageOf(uid))).toEqual({
        ...before,
        ingestion: 'Blocked',
        blockedFor: 'moderated',
        nsfwLevel: 32,
      });
      const { rows } = await holder.db.query<{ type: string; data: { ownerId?: number } }>(
        `SELECT "entityType"::text AS type, data FROM "JobQueue" WHERE type = 'PendingDelete'`
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.data.ownerId === uid)).toBe(true);
    }
  );

  it.each(Object.entries(HOLDS).filter(() => !deferred))(
    'named by %s: the row and the file go',
    async (__, uid) => {
      await remove(uid);
      expect(await queuedFiles()).toEqual([
        { entityId: imageOf(uid), data: { url: urlOf(uid), ...queued } },
      ]);
      expect(await imageRow(imageOf(uid))).toBeUndefined();
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
describe('an image a deal file entry points at', () => {
  beforeEach(() =>
    holder.db.query(`INSERT INTO "ServiceDealFileEntry" ("imageId") VALUES ($1)`, [imageOf(PLAIN)])
  );

  it('is refused to its owner, and the row and the file stay', async () => {
    await expect(
      deleteImages([imageOf(PLAIN)], { actor: { id: PLAIN, isModerator: false } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await queuedFiles()).toEqual([]);
    expect(await imageRow(imageOf(PLAIN))).toBeDefined();
  });

  it.each<[string, Parameters<typeof deleteImages>[1]['actor']]>([
    ['a moderator', { id: MODERATOR, isModerator: true }],
    ["the deal pipeline's own cleanup", { system: 'creator-service-deal-unpack' }],
    ["an account deletion's drain", { system: ACCOUNT_DELETION_DRAIN }],
  ])('is deleted by %s', async (_, actor) => {
    await deleteImages([imageOf(PLAIN)], { actor });
    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
  });

  it("answers a stranger's delete as it answers any other image of someone else's", async () => {
    await deleteImages([imageOf(PLAIN)], { actor: { id: 4242, isModerator: false } });
    expect(await imageRow(imageOf(PLAIN))).toBeDefined();
  });

  it('is left by any other system delete, which deletes the rest of its batch', async () => {
    const other = 3001;
    await holder.db.query(`INSERT INTO "Image" (id, "userId", url) VALUES ($1, $2, 'key-other')`, [
      other,
      PLAIN,
    ]);
    await deleteImages([imageOf(PLAIN), other], { actor: { system: 'some-other-job' } });
    expect(await imageRow(imageOf(PLAIN))).toBeDefined();
    expect(await imageRow(other)).toBeUndefined();
  });

  it('is refused to its owner by key, before the entry points at it', async () => {
    await holder.db.query(`DELETE FROM "ServiceDealFileEntry"`);
    await holder.db.query(
      `INSERT INTO "ServiceDealFileEntry" ("scanKey") SELECT url FROM "Image" WHERE id = $1`,
      [imageOf(PLAIN)]
    );
    await expect(
      deleteImages([imageOf(PLAIN)], { actor: { id: PLAIN, isModerator: false } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await imageRow(imageOf(PLAIN))).toBeDefined();
  });

  it("is refused to its owner as a preview's copy, and the cleanup keeps it", async () => {
    await holder.db.query(`DELETE FROM "ServiceDealFileEntry"`);
    await holder.db.query(`INSERT INTO "ServiceDealFile" ("imageId") VALUES ($1)`, [
      imageOf(PLAIN),
    ]);
    await expect(
      deleteImages([imageOf(PLAIN)], { actor: { id: PLAIN, isModerator: false } })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await deleteImages([imageOf(PLAIN)], { actor: { system: 'some-other-job' } });
    expect(await imageRow(imageOf(PLAIN))).toBeDefined();
  });

  it('control: the owner still deletes an image no entry points at', async () => {
    await holder.db.query(`DELETE FROM "ServiceDealFileEntry"`);
    await deleteImages([imageOf(PLAIN)], { actor: { id: PLAIN, isModerator: false } });
    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
  });
});

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
           CASE WHEN "createdAt" > now() THEN data || '{"waiting": true}' ELSE data END - 'prior' AS data
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

  // A member's reply never says a delete was kept, even over an image they already see blocked.
  it.each([
    ['the owner', owner, undefined, false],
    ['a moderator', { id: MODERATOR, isModerator: true }, true, true],
  ])('tells %s whether a post delete kept an image', async (_, actor, isModerator, told) => {
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${imageOf(PLAIN)}`);

    const answer = await deletePost({ id: postOf(PLAIN), actor, isModerator });
    expect(answer).toMatchObject({
      id: postOf(PLAIN),
      deletedImageIds: [],
      deleteAfterReview: told,
    });
  });

  // `ownerReportHold` covers only an unsent report, so once it is sent the owner's delete runs.
  it('is carried out by pending-deletes once a CSAM report about the owner is sent, and not before', async () => {
    await holder.db.exec(
      `INSERT INTO "CsamReport" ("userId", "reportSentAt", images, details) VALUES (${PLAIN}, NULL, '[]', '{}')`
    );
    const before = await imageRow(imageOf(PLAIN));
    expect(await deleteImages([imageOf(PLAIN)], { actor: owner })).toEqual([]);

    await runJob();
    // Not yet deleted, but already off the site.
    expect(await imageRow(imageOf(PLAIN))).toEqual({
      ...before,
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      nsfwLevel: 32,
    });
    expect(await pending()).toHaveLength(1);
    expect(await queuedFiles()).toEqual([]);

    await holder.db.exec(
      `UPDATE "CsamReport" SET "reportSentAt" = now() WHERE "userId" = ${PLAIN}`
    );
    await runJob();

    expect(await pending()).toEqual([]);
    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(await queuedFiles()).toHaveLength(1);
  });

  // Its second statement drops the purge's queue row, so both run in one transaction.
  it.each<[string, { id: number; isModerator: boolean } | { system: string }, number]>([
    ['a system', { system: 'remove-deleted-user-images' }, 1],
    ["a moderator's", { id: MODERATOR, isModerator: true }, 0],
  ])('runs %s delete in a transaction only when no moderator decided', async (_, actor, txs) => {
    vi.mocked(dbMock.dbWrite.$transaction).mockClear();

    await deleteImages([imageOf(PLAIN)], { actor });

    expect(vi.mocked(dbMock.dbWrite.$transaction)).toHaveBeenCalledTimes(txs);
  });

  // An account restore marks what a case still keeps (releaseAccountDeletionPendingDeletes).
  // A restore releases it only once the case finds nothing (Legal, #10235); any finding deletes it.
  const dismissed = `UPDATE "Report" SET status = 'Unactioned' WHERE id = 1`;
  it.each([
    ['releases, not deletes, and unhides', true, 'dismissed', dismissed, true],
    ['deletes', true, 'actioned', `UPDATE "Report" SET status = 'Actioned' WHERE id = 1`, false],
    [
      'deletes',
      true,
      'dismissed, the image blocked and reported as CSAM',
      `${dismissed};
      UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${imageOf(PLAIN)};
      INSERT INTO "CsamReport" ("userId", "reportSentAt", images, details)
      VALUES (${PLAIN}, now(), '[${imageOf(
        PLAIN
      )}]', '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}')`,
      false,
    ],
    ['deletes', false, 'dismissed', dismissed, false],
    [
      'deletes',
      true,
      'dismissed, the account deleted again',
      `${dismissed}; INSERT INTO "User" (id, "deletedAt") VALUES (${PLAIN}, now())`,
      false,
    ],
  ])(
    '%s a drain delete (restored: %s) once its case closes %s',
    async (_, restored, _closedAs, close, kept) => {
      await holder.db.exec(`
        INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
        INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1);
      `);
      const before = await imageRow(imageOf(PLAIN));
      await deleteImages([imageOf(PLAIN)], {
        actor: { system: ACCOUNT_DELETION_DRAIN },
        onlyWhere: Prisma.sql`true`,
      });
      const hidden = await imageRow(imageOf(PLAIN));
      // The hide is a moderated block, not a CSAM one, so it is no finding by itself.
      expect(hidden).toEqual({
        ...before,
        ingestion: 'Blocked',
        blockedFor: 'moderated',
        nsfwLevel: 32,
      });
      if (restored) {
        await releaseAccountDeletionPendingDeletes(PLAIN);
      }
      expect(await pending()).toEqual([
        {
          entityId: imageOf(PLAIN),
          entityType: 'Image',
          data: { deletedBy: ACCOUNT_DELETION_DRAIN, ...(restored && { releasedOnRestore: true }) },
        },
      ]);
      await runJob();
      expect(await pending()).toHaveLength(1);

      await holder.db.exec(close);
      const closed = await imageRow(imageOf(PLAIN));
      await runJob();

      expect(await pending()).toEqual([]);
      const after = await imageRow(imageOf(PLAIN));
      // Released, it is back as it was before the drain hid it, and back in search.
      if (kept) {
        expect(after).toEqual(before);
        expect(imagesMetricsSearchIndex.queueUpdate).toHaveBeenLastCalledWith([
          { id: imageOf(PLAIN), action: SearchIndexUpdateQueueAction.Update },
        ]);
      } else expect(after).not.toEqual(closed);
    }
  );

  // A case-kept delete hides the image whoever deletes it.
  it.each<[string, { id: number; isModerator: boolean } | { system: string }]>([
    ["the owner's", { id: PLAIN, isModerator: false }],
    ['a system', { system: 'remove-deleted-user-images' }],
    ["a moderator's own", { id: PLAIN, isModerator: true }],
  ])('blocks an image %s delete keeps for its case until the case closes', async (_, actor) => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1);
    `);

    expect(await deleteImages([imageOf(PLAIN)], { actor })).toEqual([]);
    expect(await imageRow(imageOf(PLAIN))).toMatchObject({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      nsfwLevel: 32,
    });
    expect(await pending()).toHaveLength(1);

    await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);
    await runJob();

    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(await pending()).toEqual([]);
    expect(await queuedFiles()).toHaveLength(1);
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
    // Hidden while its case was open, so the delete it waited for is no longer a plain owner delete.
    expect(await queuedFiles()).toEqual([
      { entityId: imageOf(PLAIN), data: { url: urlOf(PLAIN) } },
    ]);
  });

  // The owner asked while the case kept the image, and the case found nothing: theirs is a plain owner
  // delete, read as the image was before it hid it.
  it.each([
    ['keeps the object shop artwork uses for an owner delete whose case found nothing', '', true],
    [
      'control: purges it once a moderator has acted on the image since',
      `INSERT INTO "ModActivity" ("userId", activity, "entityType", "entityId")
        VALUES (${MODERATOR}, 'review', 'image', ${imageOf(PLAIN)})`,
      false,
    ],
  ])('%s', async (_, meanwhile, keeps) => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1);
    `);
    await deleteImages([imageOf(PLAIN)], { actor: owner });
    expect(await imageRow(imageOf(PLAIN))).toMatchObject({ ingestion: 'Blocked' });
    if (meanwhile) await holder.db.exec(meanwhile);

    await holder.db.exec(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 1`);
    await runJob();

    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(await queuedFiles()).toEqual([
      {
        entityId: imageOf(PLAIN),
        data: { url: urlOf(PLAIN), ...(keeps && { keepShopArtwork: true }) },
      },
    ]);
  });

  it("control: purges it for the owner's delete of an image only someone else's queued ask hid", async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1);
    `);
    await deleteImages([imageOf(PLAIN)], {
      actor: { system: ACCOUNT_DELETION_DRAIN },
      onlyWhere: Prisma.sql`true`,
    });
    await holder.db.exec(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 1`);

    await deleteImages([imageOf(PLAIN)], { actor: owner });

    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(await queuedFiles()).toEqual([
      { entityId: imageOf(PLAIN), data: { url: urlOf(PLAIN) } },
    ]);
  });

  // The hide and the drop of its purge row are two statements: a failure of the second takes back
  // the first, since a delete that hides what no moderator decided on runs them in a transaction.
  it.each([
    ['takes back the hide when its second statement fails', true],
    ['control: keeps the hide when both statements succeed', false],
  ])('%s', async (_, fails) => {
    vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (fn: unknown) => {
      await holder.db.exec('BEGIN');
      try {
        const result = await (fn as (tx: unknown) => unknown)(dbMock.dbWrite);
        await holder.db.exec('COMMIT');
        return result;
      } catch (error) {
        await holder.db.exec('ROLLBACK');
        throw error;
      }
    }) as never);
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1);
    `);
    if (fails)
      await holder.db.exec(`CREATE FUNCTION fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'statement failed'; END $$;
        CREATE TRIGGER fail_delete BEFORE DELETE ON "JobQueue" FOR EACH STATEMENT EXECUTE FUNCTION fail_delete()`);
    try {
      await deleteImages([imageOf(PLAIN)], {
        actor: { system: ACCOUNT_DELETION_DRAIN },
        onlyWhere: Prisma.sql`true`,
      }).catch(() => undefined);
    } finally {
      if (fails)
        await holder.db.exec(`DROP TRIGGER fail_delete ON "JobQueue"; DROP FUNCTION fail_delete()`);
    }

    expect(await imageRow(imageOf(PLAIN))).toMatchObject({
      ingestion: fails ? 'Scanned' : 'Blocked',
    });
    expect(await pending()).toHaveLength(fails ? 0 : 1);
  });

  // A restored account's drain-kept content comes back together, once none of it is in an open case.
  it("releases a restored account's drain deletes together once its last open case closes", async () => {
    const OTHER = 4013;
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", url, "nsfwLevel") VALUES (${OTHER}, ${PLAIN}, 'key-other', 2);
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM'), (2, 'CSAM');
      INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1), (${OTHER}, 2);
    `);
    const before = [await imageRow(imageOf(PLAIN)), await imageRow(OTHER)];
    await deleteImages([imageOf(PLAIN), OTHER], {
      actor: { system: ACCOUNT_DELETION_DRAIN },
      onlyWhere: Prisma.sql`true`,
    });
    const hidden = [await imageRow(imageOf(PLAIN)), await imageRow(OTHER)];
    expect(hidden.map((row) => row.ingestion)).toEqual(['Blocked', 'Blocked']);
    await holder.db.exec(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 1`);
    const rows = async () => [await imageRow(imageOf(PLAIN)), await imageRow(OTHER)];

    await releaseAccountDeletionPendingDeletes(PLAIN);
    expect(await rows()).toEqual(hidden);
    await runJob();
    expect(await rows()).toEqual(hidden);
    expect(await pending()).toHaveLength(2);

    await holder.db.exec(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 2`);
    await runJob();

    expect(await rows()).toEqual(before);
    expect(await pending()).toEqual([]);
  });

  // The remove-images webhook without a moderator id, and the account-wide block, write no
  // ModActivity: only the block's own write can tell the lift it is not the hide's.
  it.each([
    ['the remove-images webhook', { violationType: 'tos' }],
    ['the account-wide block', undefined],
  ])(
    'keeps the takedown %s writes, with no moderator id, on a kept image once its case closes',
    async (_, deferFor) => {
      await holder.db.exec(`
        ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "pHash" bigint;
        CREATE TABLE IF NOT EXISTS "ImageDeferredBlockEffect" (
          "imageId" int PRIMARY KEY, "violationType" text, "notifyOwner" boolean,
          "reportReason" text, "blockedBy" int);
        INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
        INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1);
      `);
      const before = await imageRow(imageOf(PLAIN));
      await deleteImages([imageOf(PLAIN)], {
        actor: { system: ACCOUNT_DELETION_DRAIN },
        onlyWhere: Prisma.sql`true`,
      });
      const hidden = await imageRow(imageOf(PLAIN));
      // Reads as removed already (image-removal-confirmation), so the takedown goes through.
      expect(hidden).toMatchObject({ ingestion: 'Blocked', blockedFor: 'moderated' });
      const marker = async () =>
        (
          await holder.db.query<{ marker: string | null }>(
            `SELECT metadata->>'keptHide' AS marker FROM "Image" WHERE id = ${imageOf(PLAIN)}`
          )
        ).rows[0].marker;
      expect(await marker()).not.toBeNull();
      passAllSql = true;
      await writeModeratorBlock([imageOf(PLAIN)], deferFor);
      passAllSql = false;
      expect(await marker()).toBeNull();
      // The account is restored, so a no-finding close lets the drain's delete go.
      expect(await lockAccountDeletionPendingDeletes(PLAIN)).toEqual([{ locked: 1 }]);
      await releaseAccountDeletionPendingDeletes(PLAIN);
      await holder.db.exec(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 1`);
      await runJob();

      // The takedown stands, and the restored account's delete is let go.
      expect(await imageRow(imageOf(PLAIN))).toEqual(hidden);
      expect(hidden).not.toEqual(before);
      expect(await pending()).toEqual([]);
    }
  );

  it('takes the stamp off a drained post a restore releases, which stays unpublished', async () => {
    await holder.db.exec(`
      UPDATE "Post" SET "publishedAt" = now() WHERE id = ${postOf(PLAIN)};
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    await deletePost({ id: postOf(PLAIN), actor: { system: ACCOUNT_DELETION_DRAIN } });
    const stamp = `SELECT "publishedAt" IS NULL AS unpublished, metadata->>'unpublishedReason' AS reason
      FROM "Post" WHERE id = ${postOf(PLAIN)}`;
    expect((await holder.db.query(stamp)).rows).toEqual([
      { unpublished: true, reason: 'pending-delete' },
    ]);
    await holder.db.exec(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 1`);

    await releaseAccountDeletionPendingDeletes(PLAIN);

    expect((await holder.db.query(stamp)).rows).toEqual([{ unpublished: true, reason: null }]);
  });

  // The drain's hide is no moderation of its own: a cleanup that replaces its restore-marked ask is
  // carried out once the case closes, not rescheduled behind that hide.
  it('carries out a cleanup that replaced a restore-marked ask once the case closes', async () => {
    const LOOSE = 4012;
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", url) VALUES (${LOOSE}, ${PLAIN}, 'key-loose2');
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "ImageReport" VALUES (${LOOSE}, 1);
    `);
    await deleteImages([LOOSE], {
      actor: { system: ACCOUNT_DELETION_DRAIN },
      onlyWhere: Prisma.sql`true`,
    });
    await releaseAccountDeletionPendingDeletes(PLAIN);
    await queueImageDeletes(kyselyOver(dbMock.dbWrite as never), [LOOSE], { ownerId: PLAIN });
    await holder.db.exec(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 1`);

    await runJob();

    expect(await imageRow(LOOSE)).toBeUndefined();
    expect(await pending()).toEqual([]);
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

  it("holds a moderator's delete of someone else's image and post, and carries it out as theirs", async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    const moderator = { id: MODERATOR, isModerator: true };

    await deletePost({ id: postOf(PLAIN), isModerator: true, actor: moderator });
    expect(await pending()).toEqual([
      {
        entityId: imageOf(PLAIN),
        entityType: 'Image',
        data: { deletedBy: `moderator:${MODERATOR}`, moderatorDelete: true },
      },
      {
        entityId: postOf(PLAIN),
        entityType: 'Post',
        data: { deletedBy: `moderator:${MODERATOR}` },
      },
    ]);

    await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);
    await runJob();

    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(await postRow(postOf(PLAIN))).toBeUndefined();
    expect(await pending()).toEqual([]);
    expect(await queuedFiles()).toEqual([
      { entityId: imageOf(PLAIN), data: { url: urlOf(PLAIN), allVersions: true } },
    ]);
  });

  // The image goes first; its finding must still reach the post (Legal, #10235).
  it('deletes a restored post whose image the case found, not only the image', async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    await deletePost({ id: postOf(PLAIN), actor: { system: ACCOUNT_DELETION_DRAIN } });
    expect(await pending()).toHaveLength(2);
    await releaseAccountDeletionPendingDeletes(PLAIN);
    expect((await pending()).map(({ data }) => data)).toEqual([
      { deletedBy: ACCOUNT_DELETION_DRAIN, releasedOnRestore: true },
      { deletedBy: ACCOUNT_DELETION_DRAIN, releasedOnRestore: true },
    ]);

    await holder.db.exec(`
      UPDATE "Report" SET status = 'Unactioned' WHERE id = 1;
      UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${imageOf(PLAIN)};
      INSERT INTO "CsamReport" ("userId", "reportSentAt", images, details)
      VALUES (${PLAIN}, now(), '[${imageOf(
      PLAIN
    )}]', '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}')
    `);
    await runJob();
    await runJob();

    expect(await pending()).toEqual([]);
    expect(
      (await holder.db.query(`SELECT id FROM "Post" WHERE id = ${postOf(PLAIN)}`)).rows
    ).toEqual([]);
  });

  it('deletes a restored post whose image the case found after another ask unmarked the image', async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    await deletePost({ id: postOf(PLAIN), actor: { system: ACCOUNT_DELETION_DRAIN } });
    await releaseAccountDeletionPendingDeletes(PLAIN);
    await deleteImages([imageOf(PLAIN)], { actor: { id: MODERATOR, isModerator: true } });
    expect(
      (await pending()).map(({ entityType, data }) => [
        entityType,
        'releasedOnRestore' in (data as object),
      ])
    ).toEqual([
      ['Image', false],
      ['Post', true],
    ]);

    await holder.db.exec(`
      UPDATE "Report" SET status = 'Unactioned' WHERE id = 1;
      UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${imageOf(PLAIN)};
      INSERT INTO "CsamReport" ("userId", "reportSentAt", images, details)
      VALUES (${PLAIN}, now(), '[${imageOf(
      PLAIN
    )}]', '{"evidenceVerifiedAt": "2026-11-01T00:00:00Z"}')
    `);
    await runJob();
    await runJob();

    expect(await pending()).toEqual([]);
    expect(
      (await holder.db.query(`SELECT id FROM "Post" WHERE id = ${postOf(PLAIN)}`)).rows
    ).toEqual([]);
  });

  it("handles a cleanup asked of a restore-marked image as a cleanup, not as the drain's delete", async () => {
    const LOOSE = 4011;
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", url) VALUES (${LOOSE}, ${PLAIN}, 'key-loose');
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "ImageReport" VALUES (${LOOSE}, 1);
    `);
    const original = await imageRow(LOOSE);
    await deleteImages([LOOSE], {
      actor: { system: ACCOUNT_DELETION_DRAIN },
      onlyWhere: Prisma.sql`true`,
    });
    await releaseAccountDeletionPendingDeletes(PLAIN);
    await queueImageDeletes(kyselyOver(dbMock.dbWrite as never), [LOOSE], { ownerId: PLAIN });
    expect((await pending()).find(({ entityId }) => entityId === LOOSE)?.data).toEqual({
      cleanup: true,
    });

    // In use again before the case closes: a cleanup no longer applies.
    await holder.db.exec(`
      INSERT INTO "ImageConnection" ("imageId") VALUES (${LOOSE});
      UPDATE "Report" SET status = 'Unactioned' WHERE id = 1;
    `);
    await runJob();

    // A cleanup that no longer applies, not carried out as an outright delete: the image stays, as it
    // was before the drain hid it.
    expect(await pending()).toEqual([]);
    expect(await imageRow(LOOSE)).toEqual(original);
  });

  // A case closed before the restore: the restore releases it only if it found nothing (Legal, #10235).
  it.each([
    ['deletes', 'Actioned', false],
    ['releases', 'Unactioned', true],
  ])(
    '%s a drain delete whose case closed %s before the account was restored',
    async (_, status, kept) => {
      await holder.db.exec(`
        INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
        INSERT INTO "ImageReport" VALUES (${imageOf(PLAIN)}, 1);
      `);
      const before = await imageRow(imageOf(PLAIN));
      await deleteImages([imageOf(PLAIN)], {
        actor: { system: ACCOUNT_DELETION_DRAIN },
        onlyWhere: Prisma.sql`true`,
      });
      expect(await imageRow(imageOf(PLAIN))).toMatchObject({ ingestion: 'Blocked' });
      await holder.db.exec(`UPDATE "Report" SET status = '${status}' WHERE id = 1`);

      await releaseAccountDeletionPendingDeletes(PLAIN);
      // Released by the restore itself, it is back as it was before the drain hid it.
      if (kept) expect(await imageRow(imageOf(PLAIN))).toEqual(before);
      expect(await pending()).toEqual(
        kept
          ? []
          : [
              {
                entityId: imageOf(PLAIN),
                entityType: 'Image',
                data: { deletedBy: ACCOUNT_DELETION_DRAIN, releasedOnRestore: true },
              },
            ]
      );

      await runJob();
      expect(await pending()).toEqual([]);
      if (kept) expect(await imageRow(imageOf(PLAIN))).toEqual(before);
      else expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    }
  );

  it('deletes a drained post whose own report was actioned before the account was restored', async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    await deletePost({ id: postOf(PLAIN), actor: { system: ACCOUNT_DELETION_DRAIN } });
    await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);

    await releaseAccountDeletionPendingDeletes(PLAIN);
    expect((await pending()).find(({ entityType }) => entityType === 'Post')?.data).toEqual({
      deletedBy: ACCOUNT_DELETION_DRAIN,
      releasedOnRestore: true,
    });

    await runJob();
    await runJob();
    expect(await pending()).toEqual([]);
    expect(
      (await holder.db.query(`SELECT id FROM "Post" WHERE id = ${postOf(PLAIN)}`)).rows
    ).toEqual([]);
  });

  it("carries out a moderator's later delete of a post a restore marked, though its case finds nothing", async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    await deletePost({ id: postOf(PLAIN), actor: { system: ACCOUNT_DELETION_DRAIN } });
    await releaseAccountDeletionPendingDeletes(PLAIN);
    await deletePost({
      id: postOf(PLAIN),
      actor: { id: MODERATOR, isModerator: true },
      isModerator: true,
    });
    expect(
      (await pending()).find(({ entityType }) => entityType === 'Post')?.data
    ).not.toHaveProperty('releasedOnRestore');

    await holder.db.exec(`UPDATE "Report" SET status = 'Unactioned' WHERE id = 1`);
    await runJob();
    await runJob();

    expect(
      (await holder.db.query(`SELECT id FROM "Post" WHERE id = ${postOf(PLAIN)}`)).rows
    ).toEqual([]);
  });

  // An account's own deletion runs as the system, under its own condition.
  it('holds a system delete under its own condition, and carries it out once the case closes', async () => {
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${imageOf(PLAIN)}`);

    expect(
      await deleteImages([imageOf(PLAIN)], {
        actor: { system: 'remove-deleted-user-images' },
        onlyWhere: Prisma.sql`true`,
      })
    ).toEqual([]);
    expect(await pending()).toEqual([
      {
        entityId: imageOf(PLAIN),
        entityType: 'Image',
        data: { deletedBy: 'remove-deleted-user-images' },
      },
    ]);
    // Not a delete the owner asked for: nothing tells them.
    expect(await told(imageOf(PLAIN))).toBe(false);

    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = NULL WHERE id = ${imageOf(PLAIN)}`);
    await runJob();

    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(await pending()).toEqual([]);
  });

  it('carries out a kept delete that keeps its stored files without queueing them', async () => {
    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${imageOf(PLAIN)}`);
    await deleteImages([imageOf(PLAIN)], {
      actor: { system: 'post-batch-rollback' },
      keepStoredFiles: true,
    });

    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = NULL WHERE id = ${imageOf(PLAIN)}`);
    await runJob();

    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(await queuedFiles()).toEqual([]);
  });

  it("keeps someone else's post delete waiting while an image in it is still kept", async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
      UPDATE "Image" SET "blockedFor" = 'CSAM' WHERE id = ${imageOf(PLAIN)};
    `);
    await deletePost({
      id: postOf(PLAIN),
      isModerator: true,
      actor: { id: MODERATOR, isModerator: true },
    });

    // The post's report is ruled on; its image is still blocked.
    await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);
    await runJob();
    expect(await postRow(postOf(PLAIN))).toBeDefined();
    expect((await pending()).map((row) => row.entityType)).toEqual(['Image', 'Post']);

    await holder.db.exec(`UPDATE "Image" SET "blockedFor" = NULL WHERE id = ${imageOf(PLAIN)}`);
    await runJob();
    expect(await imageRow(imageOf(PLAIN))).toBeUndefined();
    expect(await postRow(postOf(PLAIN))).toBeUndefined();
    expect(await pending()).toEqual([]);
  });

  it("carries out someone else's post delete though its owner added an image after it", async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    await deletePost({
      id: postOf(PLAIN),
      isModerator: true,
      actor: { id: MODERATOR, isModerator: true },
    });
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", url, "postId") VALUES (4001, ${PLAIN}, 'key-late', ${postOf(
      PLAIN
    )});
      UPDATE "Report" SET status = 'Actioned' WHERE id = 1;
    `);

    await runJob();

    expect(await postRow(postOf(PLAIN))).toBeUndefined();
    expect(await pending()).toEqual([]);
  });

  it("queues an image the job's post delete reaches while it is in a case of its own", async () => {
    await holder.db.exec(`
      INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
      INSERT INTO "PostReport" VALUES (${postOf(PLAIN)}, 1);
    `);
    await deletePost({
      id: postOf(PLAIN),
      isModerator: true,
      actor: { id: MODERATOR, isModerator: true },
    });
    // Added after the delete, then reported itself; the post's report is ruled on.
    await holder.db.exec(`
      INSERT INTO "Image" (id, "userId", url, "postId") VALUES (4001, ${PLAIN}, 'key-late', ${postOf(
      PLAIN
    )});
      INSERT INTO "Report" (id, reason) VALUES (2, 'CSAM');
      INSERT INTO "ImageReport" VALUES (4001, 2);
      UPDATE "Report" SET status = 'Actioned' WHERE id = 1;
    `);

    await runJob();

    expect(await postRow(postOf(PLAIN))).toBeUndefined();
    expect(await imageRow(4001)).toBeDefined();
    expect(await pending()).toEqual([
      // Reached by the moderator's post delete, so queued as a moderator's purge.
      {
        entityId: 4001,
        entityType: 'Image',
        data: { deletedBy: 'pending-deletes', moderatorDelete: true },
      },
    ]);
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

    it('stays, with its entry pointing at it, when a deal file entry points at it', async () => {
      await holder.db.exec(`
        UPDATE "Report" SET status = 'Actioned' WHERE id = 1;
        INSERT INTO "ServiceDealFileEntry" ("imageId") VALUES (${ORPHAN});
      `);
      await runJob();

      expect(await imageRow(ORPHAN)).toBeDefined();
      expect(
        (await holder.db.query(`SELECT 1 FROM "ServiceDealFileEntry" WHERE "imageId" = ${ORPHAN}`))
          .rows
      ).toHaveLength(1);
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

    it("goes through in use again when its owner asked too, as the moderator's", async () => {
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

    it("is replaced by the owner's own delete, which then waits only on the case", async () => {
      await holder.db.exec(`INSERT INTO "ImageConnection" ("imageId") VALUES (${ORPHAN})`);
      await deleteImages([ORPHAN], { actor: owner });
      expect(await cleanup()).toEqual({ ownerId: PLAIN });

      // In use, but the owner asked: it goes once the report is ruled on.
      await holder.db.exec(`UPDATE "Report" SET status = 'Actioned' WHERE id = 1`);
      await runJob();
      expect(await imageRow(ORPHAN)).toBeUndefined();
    });

    it("keeps a system delete's ask under a moderator's cleanup, so it goes through in use again", async () => {
      await deleteImages([ORPHAN], { actor: { system: 'remove-all-content' } });
      await queueImageDeletes(kyselyOver(dbMock.dbWrite as never), [ORPHAN], {
        ownerId: PLAIN,
        moderatorDelete: true,
      });
      expect(await cleanup()).toEqual({
        cleanup: true,
        moderatorDelete: true,
        deletedBy: 'remove-all-content',
      });

      await holder.db.exec(`
        INSERT INTO "ImageConnection" ("imageId") VALUES (${ORPHAN});
        UPDATE "Report" SET status = 'Actioned' WHERE id = 1;
      `);
      await runJob();
      expect(await imageRow(ORPHAN)).toBeUndefined();
    });
  });
});
