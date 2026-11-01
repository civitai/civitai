import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as LagHelpers from '~/server/db/db-lag-helpers';
import type * as UserService from '~/server/services/user.service';

/**
 * A collection's cover is shown only to someone who could see the image itself, and a cover can
 * only be set to an image the caller could see. Covers stored before that rule existed stay in
 * the table and are filtered when read.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof LagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbWrite),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn().mockResolvedValue(false),
}));

// `db` is the primary; `replica` has the same tables and no rows, standing in for a replica
// that has not caught up.
const holder = { db: null as unknown as PGlite, replica: null as unknown as PGlite };

const OWNER = 1;
const STRANGER = 2;
const MANAGER = 3;
const VIEWER = 4;
const VIEW_ONLY = 5;
const OTHER_MANAGER = 6;
const COLLECTION = 50;

// The permission read casts to enums the harness doesn't create; answer it as the owner's
// public collection. Everything else runs on PGlite.
const runQuery =
  (target: () => PGlite) =>
  (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    if (flat.text.includes('"CollectionReadConfiguration"'))
      return Promise.resolve([
        {
          id: COLLECTION,
          read: 'Public',
          write: 'Private',
          userId: OWNER,
          type: 'Image',
          mode: null,
          collaborationDisabledAt: null,
          contributorPermissions: null,
          hasAcceptedSeat: false,
        },
      ]);
    // getUserCollectionsWithPermissions' collection read: answered from `userCollections`.
    if (flat.text.includes('c."imageId", c."type"')) return Promise.resolve(userCollections);
    return target()
      .query(flat.text, flat.values as unknown[])
      .then((r) => r.rows);
  };
// While `replica.stale`, dbRead answers from the empty replica.
const replica = { stale: false };
dbMock.dbRead.$queryRaw.mockImplementation(
  runQuery(() => (replica.stale ? holder.replica : holder.db)) as never
);
dbMock.dbWrite.$queryRaw.mockImplementation(runQuery(() => holder.db) as never);
const userCollections: { id: number; userId: number; imageId: number | null }[] = [];

const { getServableCoverCollectionIds, withServableCovers } = await import(
  '~/server/services/collection-cover-visibility'
);
const {
  getCollectionById,
  getUserCollectionsWithPermissions,
  updateCollectionCoverImage,
  upsertCollection,
} = await import('~/server/services/collection.service');

// Images: id → [owner, post, ingestion, blockedFor, needsReview]
const PUBLISHED = 200; // stranger's image on a published public post
const REMOVED = 201; // stranger's image, removed by the scan
const REASON_ONLY = 202; // stranger's image, Scanned but carrying a removal reason
const NEEDS_REVIEW = 203; // stranger's image awaiting review
const PRIVATE_POST = 204; // stranger's image on a Private post
const UNPUBLISHED_POST = 205; // stranger's image on a draft
const SCHEDULED_POST = 206; // stranger's image on a post scheduled for later
const OWNER_UPLOAD = 207; // postless upload by the collection's owner
const STRANGER_UPLOAD = 208; // postless upload by a stranger
const MANAGER_UPLOAD = 209; // postless upload by a manager of the collection
const VIEWER_REMOVED = 210; // the viewer's own removed image
const VIEW_ONLY_UPLOAD = 211; // postless upload by a contributor without manage rights
const OTHER_MANAGER_UPLOAD = 212; // postless upload by a manager of a different collection
const PENDING_SCAN = 214; // stranger's image whose scan hasn't finished
const OWNER_REMOVED = 215; // the collection owner's own removed upload
const REMOVED_LEVEL = 213; // stranger's image, Scanned with no reason but rated at the removed level
const MINOR_R = 216; // the viewer's minor-flagged image rated R, on a published public post
const MINOR_PG13 = 217; // the viewer's minor-flagged image rated PG-13, on the same post
const UNFLAGGED_R = 218; // the viewer's image rated R with no minor flag set (NULL)

beforeAll(async () => {
  const schema = `
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      minor boolean DEFAULT false,
      "id"              integer PRIMARY KEY,
      "userId"          integer NOT NULL,
      "postId"          integer,
      "url"             text NOT NULL DEFAULT 'u',
      "nsfwLevel"       integer NOT NULL DEFAULT 1,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "ingestion"       "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "blockedFor"      text,
      "needsReview"     text,
      "metadata"        jsonb,
      "scanJobs"        jsonb
    );
    CREATE TABLE "Post" (
      "id" integer PRIMARY KEY, "userId" integer NOT NULL, "publishedAt" timestamp,
      "availability" text NOT NULL DEFAULT 'Public', "collectionId" integer
    );
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "CollectionContributor" (
      "collectionId" integer NOT NULL, "userId" integer NOT NULL,
      "permissions" "CollectionContributorPermission"[] NOT NULL
    );
    CREATE TABLE "Article" (
      "id" integer PRIMARY KEY, "coverId" integer, "status" text, "publishedAt" timestamp, "ingestion" text
    );
    CREATE TABLE "ImageConnection" ("imageId" integer, "entityId" integer, "entityType" text);
    CREATE TABLE "Bounty" ("id" integer PRIMARY KEY, "userId" integer, "availability" text);
    CREATE TABLE "BountyEntry" ("id" integer PRIMARY KEY, "bountyId" integer);

  `;
  const rows = `
    INSERT INTO "Post" ("id", "userId", "publishedAt", "availability") VALUES
      (1, ${STRANGER}, now() - interval '1 day', 'Public'),
      (2, ${STRANGER}, now() - interval '1 day', 'Private'),
      (3, ${STRANGER}, NULL, 'Public'),
      (4, ${STRANGER}, now() + interval '1 day', 'Public'),
      (5, ${VIEWER}, now() - interval '1 day', 'Public');
    INSERT INTO "Image" ("id", "userId", "postId", "ingestion", "blockedFor", "needsReview") VALUES
      (${PUBLISHED},         ${STRANGER}, 1,    'Scanned', NULL,        NULL),
      (${REMOVED},           ${STRANGER}, 1,    'Blocked', 'Moderated', NULL),
      (${REASON_ONLY}, ${STRANGER}, 1,    'Scanned', 'Moderated', NULL),
      (${NEEDS_REVIEW},      ${STRANGER}, 1,    'Scanned', NULL,        'minor'),
      (${PRIVATE_POST},      ${STRANGER}, 2,    'Scanned', NULL,        NULL),
      (${UNPUBLISHED_POST},  ${STRANGER}, 3,    'Scanned', NULL,        NULL),
      (${SCHEDULED_POST},    ${STRANGER}, 4,    'Scanned', NULL,        NULL),
      (${OWNER_UPLOAD},      ${OWNER},    NULL, 'Scanned', NULL,        NULL),
      (${STRANGER_UPLOAD},   ${STRANGER}, NULL, 'Scanned', NULL,        NULL),
      (${MANAGER_UPLOAD},    ${MANAGER},  NULL, 'Scanned', NULL,        NULL),
      (${VIEWER_REMOVED},    ${VIEWER},   5,    'Blocked', 'Moderated', NULL),
      (${VIEW_ONLY_UPLOAD},  ${VIEW_ONLY}, NULL, 'Scanned', NULL,       NULL),
      (${OTHER_MANAGER_UPLOAD}, ${OTHER_MANAGER}, NULL, 'Scanned', NULL, NULL);
    INSERT INTO "Image" ("id", "userId", "postId", "nsfwLevel") VALUES (${REMOVED_LEVEL}, ${STRANGER}, 1, 32);
    INSERT INTO "Image" ("id", "userId", "postId", "ingestion") VALUES (${PENDING_SCAN}, ${STRANGER}, 1, 'Pending');
    INSERT INTO "Image" ("id", "userId", "postId", "nsfwLevel", "minor") VALUES
      (${MINOR_R}, ${VIEWER}, 5, 4, true),
      (${MINOR_PG13}, ${VIEWER}, 5, 2, true),
      (${UNFLAGGED_R}, ${VIEWER}, 5, 4, NULL);
    INSERT INTO "Image" ("id", "userId", "postId", "ingestion", "blockedFor") VALUES (${OWNER_REMOVED}, ${OWNER}, NULL, 'Blocked', 'Moderated');
    INSERT INTO "CollectionContributor" ("collectionId", "userId", "permissions") VALUES
      (${COLLECTION}, ${MANAGER}, ARRAY['VIEW', 'MANAGE']::"CollectionContributorPermission"[]),
      (${COLLECTION}, ${VIEW_ONLY}, ARRAY['VIEW', 'ADD']::"CollectionContributorPermission"[]),
      (51, ${OTHER_MANAGER}, ARRAY['VIEW', 'MANAGE']::"CollectionContributorPermission"[]);
  `;
  holder.db = new PGlite();
  holder.replica = new PGlite();
  await holder.db.exec(schema + rows);
  await holder.replica.exec(schema);
});

const servable = async (imageId: number, viewer?: { id?: number; isModerator?: boolean }) =>
  (
    await getServableCoverCollectionIds(
      [{ collectionId: COLLECTION, collectionOwnerId: OWNER, imageId }],
      viewer
    )
  ).has(COLLECTION);

describe('which covers a stranger is shown', () => {
  it.each([
    ['an image on a published public post', PUBLISHED],
    ["the collection owner's own upload", OWNER_UPLOAD],
    ["a collection manager's upload", MANAGER_UPLOAD],
  ])('shows %s', async (_, imageId) => {
    expect(await servable(imageId)).toBe(true);
  });

  it.each([
    ['a removed image', REMOVED],
    ['an image carrying a removal reason', REASON_ONLY],
    ['an image awaiting review', NEEDS_REVIEW],
    ['an image on a Private post', PRIVATE_POST],
    ['an image on a draft post', UNPUBLISHED_POST],
    ['an image on a post scheduled for later', SCHEDULED_POST],
    ["another user's upload", STRANGER_UPLOAD],
    ["the upload of a contributor who can't manage the collection", VIEW_ONLY_UPLOAD],
    ["the upload of another collection's manager", OTHER_MANAGER_UPLOAD],
    ['an image rated at the removed level', REMOVED_LEVEL],
    ['an image still being scanned', PENDING_SCAN],
  ])('hides %s', async (_, imageId) => {
    expect(await servable(imageId)).toBe(false);
  });

  it("shows the image's owner their own removed image, and nobody else", async () => {
    expect(await servable(VIEWER_REMOVED, { id: VIEWER })).toBe(true);
    expect(await servable(VIEWER_REMOVED, { id: STRANGER })).toBe(false);
  });

  it('shows staff any cover', async () => {
    expect(await servable(REMOVED, { id: 99, isModerator: true })).toBe(true);
  });
});

describe('a minor-flagged cover', () => {
  it('is shown at R only to its owner and staff', async () => {
    expect(await servable(MINOR_R)).toBe(false);
    expect(await servable(MINOR_R, { id: STRANGER })).toBe(false);
    expect(await servable(MINOR_R, { id: VIEWER })).toBe(true);
    expect(await servable(MINOR_R, { id: 99, isModerator: true })).toBe(true);
  });

  it('is shown to anyone at PG-13', async () => {
    expect(await servable(MINOR_PG13)).toBe(true);
    expect(await servable(MINOR_PG13, { id: STRANGER })).toBe(true);
  });

  it('is shown to anyone at R when the flag is unset', async () => {
    expect(await servable(UNFLAGGED_R, { id: STRANGER })).toBe(true);
  });
});

describe('withServableCovers', () => {
  it('nulls only the covers the viewer may not see, keeping order and the rest of each row', async () => {
    const rows = [
      { id: 1, userId: OWNER, name: 'a', image: { id: PUBLISHED } },
      { id: 2, userId: OWNER, name: 'b', image: { id: REMOVED } },
      { id: 3, userId: OWNER, name: 'c', image: null },
      { id: 4, userId: OWNER, name: 'd', image: { id: PRIVATE_POST } },
    ];
    expect(await withServableCovers(rows)).toEqual([
      rows[0],
      { ...rows[1], image: null },
      rows[2],
      { ...rows[3], image: null },
    ]);
  });
});

describe('getCollectionById', () => {
  beforeEach(() => {
    replica.stale = true;
  });
  afterEach(() => {
    replica.stale = false;
  });

  const read = async (imageId: number, viewer?: { id?: number; isModerator?: boolean }) => {
    vi.mocked(dbMock.dbWrite.collection.findUnique).mockResolvedValueOnce({
      id: COLLECTION,
      userId: OWNER,
      nsfwLevel: 1,
      metadata: {},
      tags: [],
      image: { id: imageId, url: 'u', nsfwLevel: 1, meta: null },
    } as never);
    return getCollectionById({ input: { id: COLLECTION }, viewer });
  };
  const coverOf = async (imageId: number, viewer?: { id?: number; isModerator?: boolean }) =>
    (await read(imageId, viewer)).image?.id ?? null;

  it('marks a stored cover the viewer may not see as hidden, so an edit keeps it', async () => {
    expect((await read(REMOVED, { id: OWNER })).coverHidden).toBe(true);
    expect((await read(PUBLISHED, { id: OWNER })).coverHidden).toBe(false);
  });

  it('says nothing about a hidden cover when read with no viewer', async () => {
    expect((await read(REMOVED)).coverHidden).toBe(false);
  });

  it('returns a cover anyone could see (control)', async () => {
    expect(await coverOf(PUBLISHED)).toBe(PUBLISHED);
  });

  it.each([
    ['a removed image', REMOVED],
    ['an image on a Private post', PRIVATE_POST],
    ['an image on a draft post', UNPUBLISHED_POST],
  ])('returns no cover when the stored cover is %s', async (_, imageId) => {
    expect(await coverOf(imageId)).toBeNull();
  });

  it("returns the viewer's own image to them", async () => {
    expect(await coverOf(VIEWER_REMOVED, { id: VIEWER })).toBe(VIEWER_REMOVED);
  });
});

describe('getUserCollectionsWithPermissions', () => {
  beforeEach(() => {
    replica.stale = true;
  });
  afterEach(() => {
    replica.stale = false;
  });

  it("returns covers the user may see and drops the rest, including other users' hidden images", async () => {
    userCollections.splice(
      0,
      userCollections.length,
      { id: 60, userId: OWNER, imageId: PUBLISHED },
      { id: 61, userId: OWNER, imageId: PRIVATE_POST },
      { id: 62, userId: OWNER, imageId: OWNER_UPLOAD },
      { id: 63, userId: OWNER, imageId: null }
    );
    vi.mocked(dbMock.dbRead.image.findMany).mockImplementation((async (args: {
      where: { id: { in: number[] } };
    }) => args.where.id.in.map((id) => ({ id }))) as never);
    vi.mocked(dbMock.dbRead.tagsOnCollection.findMany).mockResolvedValue([]);
    vi.mocked(dbMock.dbRead.user.findMany).mockResolvedValue([]);

    const rows = await getUserCollectionsWithPermissions({ input: { userId: OWNER } as never });
    expect(Object.fromEntries(rows.map((r) => [r.id, r.image?.id ?? null]))).toEqual({
      60: PUBLISHED,
      61: null,
      62: OWNER_UPLOAD,
      63: null,
    });
  });

  it("keeps the user's own hidden image as their cover", async () => {
    userCollections.splice(0, userCollections.length, {
      id: 64,
      userId: OWNER,
      imageId: VIEWER_REMOVED,
    });
    vi.mocked(dbMock.dbRead.image.findMany).mockImplementation((async (args: {
      where: { id: { in: number[] } };
    }) => args.where.id.in.map((id) => ({ id }))) as never);
    vi.mocked(dbMock.dbRead.tagsOnCollection.findMany).mockResolvedValue([]);
    vi.mocked(dbMock.dbRead.user.findMany).mockResolvedValue([]);

    const rows = await getUserCollectionsWithPermissions({ input: { userId: VIEWER } as never });
    expect(rows.map((r) => r.image?.id ?? null)).toEqual([VIEWER_REMOVED]);
  });
});

describe('updateCollectionCoverImage', () => {
  beforeEach(() => {
    vi.mocked(dbMock.dbWrite.collection.update).mockReset();
    vi.mocked(dbMock.dbWrite.collection.update).mockResolvedValue({ id: COLLECTION } as never);
  });

  const setCover = (imageId: number, isModerator = false) =>
    updateCollectionCoverImage({
      input: { id: COLLECTION, imageId, userId: OWNER, isModerator },
    });

  it('sets a cover the owner could see (control)', async () => {
    await setCover(PUBLISHED);
    expect(dbMock.dbWrite.collection.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another user's removed image", REMOVED],
    ["another user's image on a Private post", PRIVATE_POST],
    ["another user's image on a draft post", UNPUBLISHED_POST],
    ["another user's upload", STRANGER_UPLOAD],
    ["another user's image awaiting review", NEEDS_REVIEW],
  ])('refuses %s', async (_, imageId) => {
    await expect(setCover(imageId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(dbMock.dbWrite.collection.update).not.toHaveBeenCalled();
  });

  it('sets an image image.get would show, but keeps it from strangers when it carries a removal reason', async () => {
    // The write follows image.get's rule, which doesn't read the removal reason; the read rule does.
    await setCover(REASON_ONLY);
    expect(dbMock.dbWrite.collection.update).toHaveBeenCalledTimes(1);
    expect(await servable(REASON_ONLY)).toBe(false);
  });

  it('lets staff set any cover', async () => {
    await setCover(REMOVED, true);
    expect(dbMock.dbWrite.collection.update).toHaveBeenCalledTimes(1);
  });
});

describe('upsertCollection with no cover sent', () => {
  beforeEach(() => {
    replica.stale = true;
  });
  afterEach(() => {
    replica.stale = false;
  });

  const edit = async (storedCover: number, isModerator = false) => {
    vi.mocked(dbMock.dbWrite.collection.findUnique).mockResolvedValue({
      id: COLLECTION,
      name: 'old',
      description: null,
      read: 'Public',
      write: 'Private',
      availability: 'Public',
      mode: null,
      metadata: {},
      userId: OWNER,
      image: { id: storedCover },
    } as never);
    vi.mocked(dbMock.dbWrite.collection.update).mockReset();
    vi.mocked(dbMock.dbWrite.collection.update).mockResolvedValue({ id: COLLECTION } as never);
    await upsertCollection({
      input: {
        id: COLLECTION,
        name: 'renamed',
        image: null,
        type: 'Image',
        read: 'Public',
        write: 'Private',
        userId: OWNER,
        isModerator,
        isMember: true,
      } as never,
    });
    expect(dbMock.dbWrite.collection.update).toHaveBeenCalledTimes(1);
    return vi.mocked(dbMock.dbWrite.collection.update).mock.calls[0]?.[0]?.data?.image;
  };

  it('keeps a stored cover hidden from the editor when they only rename the collection', async () => {
    expect(await edit(REMOVED)).toBeUndefined();
  });

  it('removes a stored cover the editor can see when they clear it (control)', async () => {
    expect(await edit(PUBLISHED)).toEqual({ disconnect: true });
  });

  it("removes the editor's own hidden image when they clear it", async () => {
    expect(await edit(OWNER_REMOVED)).toEqual({ disconnect: true });
  });

  it('lets staff remove a hidden cover', async () => {
    expect(await edit(REMOVED, true)).toEqual({ disconnect: true });
  });
});
