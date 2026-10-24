import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import {
  ArticleStatus,
  CollectionContributorPermission,
  CollectionInviteStatus,
  CollectionItemStatus,
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
  ModelModifier,
  ModelStatus,
} from '~/shared/utils/prisma/enums';

// Booting PGlite (WASM Postgres) can exceed the default 10s hook timeout on a
// contended runner. Relaxing it can only help a slow box, never mask a failure.
vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The review queue hydrates through the feed services. Echoing every requested id back isolates
// the queue's own SQL: whatever it selected is exactly what it returns.
const { echoIds } = vi.hoisted(() => ({
  echoIds: (ids: number[] = []) => Promise.resolve({ items: ids.map((id) => ({ id })) }),
}));
vi.mock('~/server/services/model.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getModelsWithImagesAndModelVersions: ({ input }: { input: { ids: number[] } }) =>
    echoIds(input.ids),
}));
vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getArticles: ({ ids }: { ids: number[] }) => echoIds(ids),
}));
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAllImages: ({ ids }: { ids: number[] }) => echoIds(ids),
}));
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPostsInfinite: ({ ids }: { ids: number[] }) => echoIds(ids),
}));

const holder = { db: null as unknown as PGlite };

const toPglite = (strings: TemplateStringsArray, ...values: unknown[]) => {
  const flat = Prisma.sql(strings, ...(values as never[]));
  return holder.db.query(flat.text, flat.values as unknown[]).then((r) => r.rows);
};
dbMock.dbRead.$queryRaw.mockImplementation(toPglite as never);

const {
  getPendingCollectionReviewCounts,
  getPendingReviewCount,
  getCollectionItemsByCollectionId,
} = await import('~/server/services/collection.service');

// civitai.red and blue serve every level; civitai.com serves PG and PG-13.
const ALL = allBrowsingLevelsFlag;
const SFW = sfwBrowsingLevelsFlag;

const OWNER = 100;
const MANAGER = 101; // holds MANAGE on someone else's collection
const FOLLOWER = 102; // holds VIEW + ADD on someone else's collection, never MANAGE
const STRANGER = 103;
const REVIEWER = 104; // owns only the per-type visibility collections
const CONTEST_MANAGER = 105; // owns only the mature-content collections

const OWNED_WITH_QUEUE = 9001;
const OWNED_EMPTY = 9002; // owned, but every item already decided
const OWNED_CONTEST = 9003; // 🔴 the mode canary
const MANAGED = 9004; // owned by OWNER, MANAGER holds MANAGE
const FOLLOWED = 9005; // owned by OWNER, FOLLOWER holds VIEW + ADD

// One collection per target type, each holding one or two items the queue shows and several it
// hides, all in REVIEW.
const VIS_MODEL = 9101;
const VIS_IMAGE = 9102;
const VIS_POST = 9103;
const VIS_ARTICLE = 9104;
const VIS_MODEL3D = 9105;

// Every REVIEW item mature (R, X, XXX), and one with a PG item beside a mature one.
const MATURE_ONLY = 9201;
const MIXED = 9202;

// Visible targets. `VISIBLE_MODEL` also backs every row in the permission fixtures above, so
// those tests keep counting what they always counted.
const VISIBLE_MODEL = 1;
const PUBLISHED_POST = 1;
const DRAFT_POST = 2;
const SCHEDULED_POST = 3;
const UNRATED_POST = 4;
const BLOCKED_POST = 5;

const enumType = (name: string, values: object) =>
  `CREATE TYPE "${name}" AS ENUM (${Object.values(values)
    .map((v) => `'${v}'`)
    .join(', ')});`;

beforeAll(async () => {
  holder.db = new PGlite();
  // Real enum types, not text stand-ins: the statements cast to these, and a text
  // column would accept casts Postgres rejects on the enum.
  await holder.db.exec(`
    ${enumType('CollectionItemStatus', CollectionItemStatus)}
    ${enumType('CollectionContributorPermission', CollectionContributorPermission)}
    ${enumType('CollectionMode', CollectionMode)}
    ${enumType('CollectionReadConfiguration', CollectionReadConfiguration)}
    ${enumType('CollectionWriteConfiguration', CollectionWriteConfiguration)}
    ${enumType('CollectionType', CollectionType)}
    ${enumType('CollectionInviteStatus', CollectionInviteStatus)}
    ${enumType('ModelStatus', ModelStatus)}
    ${enumType('ModelModifier', ModelModifier)}
    ${enumType('ArticleStatus', ArticleStatus)}

    CREATE TABLE "Collection" (
      "id"     integer PRIMARY KEY,
      "userId" integer NOT NULL,
      "mode"   "CollectionMode",
      "type"   "CollectionType",
      "read"   "CollectionReadConfiguration" NOT NULL DEFAULT 'Private',
      "write"  "CollectionWriteConfiguration" NOT NULL DEFAULT 'Private',
      "collaborationDisabledAt" timestamp
    );
    CREATE TABLE "CollectionContributor" (
      "userId"       integer NOT NULL,
      "collectionId" integer NOT NULL,
      "permissions"  "CollectionContributorPermission"[] NOT NULL,
      PRIMARY KEY ("userId", "collectionId")
    );
    CREATE TABLE "CollectionInvite" (
      "id"           integer PRIMARY KEY,
      "collectionId" integer NOT NULL,
      "userId"       integer NOT NULL,
      "status"       "CollectionInviteStatus" NOT NULL
    );
    CREATE TABLE "CollectionItem" (
      "id"           integer PRIMARY KEY,
      "collectionId" integer NOT NULL,
      "status"       "CollectionItemStatus" NOT NULL DEFAULT 'ACCEPTED',
      "modelId"      integer,
      "imageId"      integer,
      "postId"       integer,
      "articleId"    integer,
      "model3dId"    integer,
      "tagId"        integer,
      "reviewedById" integer,
      "rejectionReason" text,
      "rejectionDetail" text,
      "createdAt"    timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE "ModelMetric" (
      "modelId"   integer PRIMARY KEY,
      "status"    "ModelStatus" NOT NULL,
      "mode"      "ModelModifier",
      "nsfwLevel" integer NOT NULL
    );
    CREATE TABLE "Post" (
      "id"          integer PRIMARY KEY,
      "publishedAt" timestamp,
      "nsfwLevel"   integer NOT NULL
    );
    CREATE TABLE "Image" (
      "id"              integer PRIMARY KEY,
      "postId"          integer,
      "nsfwLevel"       integer NOT NULL,
      "modelRestricted" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Article" (
      "id"          integer PRIMARY KEY,
      "status"      "ArticleStatus" NOT NULL,
      "publishedAt" timestamp,
      "nsfwLevel"   integer NOT NULL
    );

    INSERT INTO "Collection" ("id","userId","mode") VALUES
      (${OWNED_WITH_QUEUE}, ${OWNER}, NULL),
      (${OWNED_EMPTY},      ${OWNER}, NULL),
      (${OWNED_CONTEST},    ${OWNER}, 'Contest'),
      (${MANAGED},          ${OWNER}, NULL),
      (${FOLLOWED},         ${OWNER}, NULL),
      (${VIS_MODEL},        ${REVIEWER}, 'Contest'),
      (${VIS_IMAGE},        ${REVIEWER}, 'Contest'),
      (${VIS_POST},         ${REVIEWER}, 'Contest'),
      (${VIS_ARTICLE},      ${REVIEWER}, 'Contest'),
      (${VIS_MODEL3D},      ${REVIEWER}, 'Contest'),
      (${MATURE_ONLY},      ${CONTEST_MANAGER}, 'Contest'),
      (${MIXED},            ${CONTEST_MANAGER}, 'Contest');

    INSERT INTO "CollectionContributor" ("userId","collectionId","permissions") VALUES
      -- A real co-manager. Carries VIEW too, matching every such row on prod.
      (${MANAGER},  ${MANAGED},  ARRAY['VIEW','MANAGE']::"CollectionContributorPermission"[]),
      -- Elevated, but not to MANAGE. Must count nothing.
      (${FOLLOWER}, ${FOLLOWED}, ARRAY['VIEW','ADD']::"CollectionContributorPermission"[]);

    INSERT INTO "ModelMetric" ("modelId","status","mode","nsfwLevel") VALUES
      (${VISIBLE_MODEL}, 'Published', NULL, 1),
      (2, 'Deleted', NULL, 1),
      (3, 'Unpublished', NULL, 1),
      (4, 'UnpublishedViolation', NULL, 1),
      (5, 'Published', 'TakenDown', 1),
      (6, 'Published', 'Archived', 1),
      -- 7 has no ModelMetric row at all
      (8, 'Published', NULL, 0),
      -- Blocked only: allBrowsingLevelsFlag has no Blocked bit, so the queue never hydrates it.
      (9, 'Published', NULL, 32),
      -- PG plus Blocked still matches the PG bit and shows.
      (10, 'Published', NULL, 33),
      (11, 'Published', NULL, 4);

    INSERT INTO "Post" ("id","publishedAt","nsfwLevel") VALUES
      (${PUBLISHED_POST}, now() - interval '1 day', 1),
      (${DRAFT_POST},     NULL, 1),
      (${SCHEDULED_POST}, now() + interval '1 day', 1),
      (${UNRATED_POST},   now() - interval '1 day', 0),
      (${BLOCKED_POST},   now() - interval '1 day', 32);

    INSERT INTO "Image" ("id","postId","nsfwLevel","modelRestricted") VALUES
      (1, ${PUBLISHED_POST}, 1, false),
      -- The queue reads images with pending: true, so an image on a draft post still shows.
      (2, ${DRAFT_POST}, 1, false),
      (3, NULL, 1, false),
      -- R-rated on a license-restricted base model: getAllImages never returns it.
      (4, ${PUBLISHED_POST}, 4, true),
      -- Its post row is gone.
      (5, 999, 1, false),
      (6, ${PUBLISHED_POST}, 32, false),
      -- Unrated: pending: true keeps nsfwLevel 0 for images, unlike every other target.
      (7, ${PUBLISHED_POST}, 0, false),
      (8, ${PUBLISHED_POST}, 8, false);

    INSERT INTO "Article" ("id","status","publishedAt","nsfwLevel") VALUES
      (1, 'Published', now() - interval '1 day', 1),
      (2, 'Draft', NULL, 1),
      (3, 'Unpublished', now() - interval '1 day', 1),
      (4, 'Published', NULL, 1),
      (5, 'Published', now() - interval '1 day', 0),
      (6, 'Published', now() - interval '1 day', 32),
      (7, 'Published', now() - interval '1 day', 16);

    INSERT INTO "CollectionItem" ("id","collectionId","status","modelId") VALUES
      (1, ${OWNED_WITH_QUEUE}, 'REVIEW',   ${VISIBLE_MODEL}),
      (2, ${OWNED_WITH_QUEUE}, 'REVIEW',   ${VISIBLE_MODEL}),
      (3, ${OWNED_WITH_QUEUE}, 'ACCEPTED', ${VISIBLE_MODEL}),
      (4, ${OWNED_WITH_QUEUE}, 'REJECTED', ${VISIBLE_MODEL}),
      (5, ${OWNED_EMPTY},      'ACCEPTED', ${VISIBLE_MODEL}),
      (6, ${OWNED_EMPTY},      'REJECTED', ${VISIBLE_MODEL}),
      (7, ${OWNED_CONTEST},    'REVIEW',   ${VISIBLE_MODEL}),
      (8, ${MANAGED},          'REVIEW',   ${VISIBLE_MODEL}),
      (9, ${MANAGED},          'REVIEW',   ${VISIBLE_MODEL}),
      (10, ${MANAGED},         'REVIEW',   ${VISIBLE_MODEL}),
      (11, ${FOLLOWED},        'REVIEW',   ${VISIBLE_MODEL});

    INSERT INTO "CollectionItem" ("id","collectionId","status","modelId") VALUES
      (101, ${VIS_MODEL}, 'REVIEW', ${VISIBLE_MODEL}),
      (102, ${VIS_MODEL}, 'REVIEW', 2),
      (103, ${VIS_MODEL}, 'REVIEW', 3),
      (104, ${VIS_MODEL}, 'REVIEW', 4),
      (105, ${VIS_MODEL}, 'REVIEW', 5),
      (106, ${VIS_MODEL}, 'REVIEW', 6),
      (107, ${VIS_MODEL}, 'REVIEW', 7),
      (108, ${VIS_MODEL}, 'REVIEW', 8),
      (109, ${VIS_MODEL}, 'REVIEW', 9),
      (110, ${VIS_MODEL}, 'REVIEW', 10);
    INSERT INTO "CollectionItem" ("id","collectionId","status","imageId") VALUES
      (201, ${VIS_IMAGE}, 'REVIEW', 1),
      (202, ${VIS_IMAGE}, 'REVIEW', 2),
      (203, ${VIS_IMAGE}, 'REVIEW', 3),
      (204, ${VIS_IMAGE}, 'REVIEW', 4),
      (205, ${VIS_IMAGE}, 'REVIEW', 5),
      (206, ${VIS_IMAGE}, 'REVIEW', 404),
      (207, ${VIS_IMAGE}, 'REVIEW', 6),
      (208, ${VIS_IMAGE}, 'REVIEW', 7);
    INSERT INTO "CollectionItem" ("id","collectionId","status","postId") VALUES
      (301, ${VIS_POST}, 'REVIEW', ${PUBLISHED_POST}),
      (302, ${VIS_POST}, 'REVIEW', ${DRAFT_POST}),
      (303, ${VIS_POST}, 'REVIEW', ${SCHEDULED_POST}),
      (304, ${VIS_POST}, 'REVIEW', ${UNRATED_POST}),
      (305, ${VIS_POST}, 'REVIEW', 404),
      (306, ${VIS_POST}, 'REVIEW', ${BLOCKED_POST});
    -- Hydration judges a row by its first target column (model, post, image, article), so a draft
    -- post hides the row even though its image alone would show.
    INSERT INTO "CollectionItem" ("id","collectionId","status","postId","imageId") VALUES
      (209, ${VIS_IMAGE}, 'REVIEW', ${DRAFT_POST}, 1);
    INSERT INTO "CollectionItem" ("id","collectionId","status","articleId") VALUES
      (401, ${VIS_ARTICLE}, 'REVIEW', 1),
      (402, ${VIS_ARTICLE}, 'REVIEW', 2),
      (403, ${VIS_ARTICLE}, 'REVIEW', 3),
      (404, ${VIS_ARTICLE}, 'REVIEW', 4),
      (405, ${VIS_ARTICLE}, 'REVIEW', 5),
      (406, ${VIS_ARTICLE}, 'REVIEW', 6);
    INSERT INTO "CollectionItem" ("id","collectionId","status","model3dId") VALUES
      (501, ${VIS_MODEL3D}, 'REVIEW', 1);
    INSERT INTO "CollectionItem" ("id","collectionId","status","modelId","imageId","articleId") VALUES
      (601, ${MATURE_ONLY}, 'REVIEW', 11, NULL, NULL),
      (602, ${MATURE_ONLY}, 'REVIEW', NULL, 8, NULL),
      (603, ${MATURE_ONLY}, 'REVIEW', NULL, NULL, 7),
      (701, ${MIXED}, 'REVIEW', ${VISIBLE_MODEL}, NULL, NULL),
      (702, ${MIXED}, 'REVIEW', 11, NULL, NULL);
  `);
});

describe('getPendingCollectionReviewCounts', () => {
  it('counts REVIEW rows in owned collections and nothing else', async () => {
    const { total, byCollection } = await getPendingCollectionReviewCounts({
      userId: OWNER,
      levels: ALL,
    });

    // 2 in OWNED_WITH_QUEUE + 1 in OWNED_CONTEST + 3 in MANAGED + 1 in FOLLOWED,
    // all five owned by OWNER. ACCEPTED and REJECTED rows contribute nothing.
    expect(byCollection[OWNED_WITH_QUEUE]).toBe(2);
    expect(total).toBe(7);
  });

  it('omits a collection with nothing pending rather than reporting zero', async () => {
    // Absence, not a 0 entry: the sidebar reads `?? 0`, and a present zero would
    // make QueueCountBadge's own "a zero draws nothing" rule the only thing
    // standing between an empty queue and a badge.
    const { byCollection } = await getPendingCollectionReviewCounts({ userId: OWNER, levels: ALL });

    expect(byCollection[OWNED_EMPTY]).toBeUndefined();
  });

  it('counts a Contest collection like any other', async () => {
    // 🔴 The mode canary. Most of everything pending is Contest mode, and
    // the same /review page reviews it. A `mode` filter added here would look
    // like a reasonable narrowing and would silently blank the badge for almost
    // every queue that actually exists.
    const { byCollection } = await getPendingCollectionReviewCounts({ userId: OWNER, levels: ALL });

    expect(byCollection[OWNED_CONTEST]).toBe(1);
  });

  it('counts a collection the user manages but does not own', async () => {
    const { total, byCollection } = await getPendingCollectionReviewCounts({
      userId: MANAGER,
      levels: ALL,
    });

    expect(byCollection[MANAGED]).toBe(3);
    expect(total).toBe(3);
  });

  it('counts nothing for a contributor without MANAGE', async () => {
    // FOLLOWER holds VIEW and ADD on a collection with a pending row. A
    // permission test that checks for "any contributor row" — or one that
    // overlaps the array instead of testing membership — passes every other
    // case in this file and fails only here.
    const { total, byCollection } = await getPendingCollectionReviewCounts({
      userId: FOLLOWER,
      levels: ALL,
    });

    expect(byCollection).toEqual({});
    expect(total).toBe(0);
  });

  it('counts nothing for a user with no collections at all', async () => {
    const { total, byCollection } = await getPendingCollectionReviewCounts({
      userId: STRANGER,
      levels: ALL,
    });

    expect(total).toBe(0);
    expect(byCollection).toEqual({});
  });
});

// The badge must equal what /collections/[id]/review shows. Each fixture collection holds visible
// items (which must still count, so a predicate that drops everything fails too) beside hidden
// ones (which main counted, so every case here was red there).
const VISIBLE_IDS: Record<number, number[]> = {
  // The Published, rated, live models. Deleted, Unpublished, UnpublishedViolation, TakenDown,
  // Archived, missing-metric, unrated and Blocked-only models are hidden.
  [VIS_MODEL]: [101, 110],
  // Images on any existing post, draft posts included, unrated included; not the
  // license-restricted one, not a Blocked one, not an image with no post or a missing post, not a
  // missing image, and not one on a row whose draft post is judged first.
  [VIS_IMAGE]: [201, 202, 208],
  // Only the published, rated post. Not a draft, a scheduled post, an unrated, Blocked or missing
  // one.
  [VIS_POST]: [301],
  // Only the Published article with a publish date and a non-Blocked rating.
  [VIS_ARTICLE]: [401],
  // The queue never selects model3dId, so it shows none: the badge matches it at zero. A
  // follow-up owns real Model3D review support; when it lands, this expectation changes with it.
  [VIS_MODEL3D]: [],
};

describe('review counts match what the review queue shows', () => {
  beforeEach(() => {
    dbMock.dbWrite.$queryRaw.mockImplementation(toPglite as never);
    dbMock.dbWrite.collection.findUniqueOrThrow.mockImplementation((async ({
      where,
    }: {
      where: { id: number };
    }) => ({ id: where.id, type: null, mode: CollectionMode.Contest })) as never);
  });

  it.each([
    ['Model', VIS_MODEL],
    ['Image', VIS_IMAGE],
    ['Post', VIS_POST],
    ['Article', VIS_ARTICLE],
    ['Model3D', VIS_MODEL3D],
  ])('the badge counts only %s items the queue can show', async (_type, collectionId) => {
    const { byCollection } = await getPendingCollectionReviewCounts({
      userId: REVIEWER,
      levels: ALL,
    });

    expect(byCollection[collectionId] ?? 0).toBe(VISIBLE_IDS[collectionId].length);
  });

  it.each([
    ['Model', VIS_MODEL],
    ['Image', VIS_IMAGE],
    ['Post', VIS_POST],
    ['Article', VIS_ARTICLE],
    ['Model3D', VIS_MODEL3D],
  ])('the Review N button counts only %s items the queue can show', async (_type, collectionId) => {
    expect(await getPendingReviewCount(collectionId, ALL)).toBe(VISIBLE_IDS[collectionId].length);
  });

  // 🔴 Pins the queue reading the same predicate as the counts. Removing the fragment from the
  // queue's forReview SQL, or forking a second copy for it, reddens this before a badge drifts.
  it.each([
    ['Model', VIS_MODEL],
    ['Image', VIS_IMAGE],
    ['Post', VIS_POST],
    ['Article', VIS_ARTICLE],
    ['Model3D', VIS_MODEL3D],
  ])(
    'the review queue selects exactly the %s items the counts count',
    async (_type, collectionId) => {
      const { items } = await getCollectionItemsByCollectionId({
        input: {
          collectionId,
          statuses: [CollectionItemStatus.REVIEW],
          forReview: true,
          limit: 50,
          browsingLevel: ALL,
        } as never,
        user: { id: REVIEWER } as never,
      });

      expect(items.map((i) => i.id).sort((a, b) => a - b)).toEqual(VISIBLE_IDS[collectionId]);
    }
  );
});

// The badge on civitai.com counts only what the .com queue can show. Both counts take the
// domain's ceiling: PG/PG-13 there, every level on civitai.red, which must count as before.
describe('review counts hold to the domain ceiling', () => {
  beforeEach(() => {
    dbMock.dbWrite.$queryRaw.mockImplementation(toPglite as never);
    dbMock.dbWrite.collection.findUniqueOrThrow.mockImplementation((async ({
      where,
    }: {
      where: { id: number };
    }) => ({ id: where.id, type: null, mode: CollectionMode.Contest })) as never);
  });

  const queueIds = async (collectionId: number, browsingLevel: number) => {
    const { items } = await getCollectionItemsByCollectionId({
      input: {
        collectionId,
        statuses: [CollectionItemStatus.REVIEW],
        forReview: true,
        limit: 50,
        browsingLevel,
      } as never,
      user: { id: CONTEST_MANAGER } as never,
    });
    return items.map((i) => i.id).sort((a, b) => a - b);
  };

  it('on civitai.com, counts nothing for a queue holding only mature items', async () => {
    const { total, byCollection } = await getPendingCollectionReviewCounts({
      userId: CONTEST_MANAGER,
      levels: SFW,
    });

    expect(byCollection[MATURE_ONLY]).toBeUndefined();
    expect(byCollection[MIXED]).toBe(1);
    expect(total).toBe(1);
    expect(await getPendingReviewCount(MATURE_ONLY, SFW)).toBe(0);
    expect(await queueIds(MATURE_ONLY, SFW)).toEqual([]);
    expect(await queueIds(MIXED, SFW)).toEqual([701]);
  });

  it('keeps Blocked targets out of the queue when the client sends the Blocked bit', async () => {
    const BLOCKED_BIT = 32;
    const { items } = await getCollectionItemsByCollectionId({
      input: {
        collectionId: VIS_MODEL,
        statuses: [CollectionItemStatus.REVIEW],
        forReview: true,
        limit: 50,
        browsingLevel: ALL | BLOCKED_BIT,
      } as never,
      user: { id: REVIEWER } as never,
    });

    expect(items.map((i) => i.id).sort((a, b) => a - b)).toEqual(VISIBLE_IDS[VIS_MODEL]);
  });

  it('counts the mature items at every level, for the civitai.red pointer', async () => {
    expect(await getPendingReviewCount(MATURE_ONLY, ALL)).toBe(3);
  });

  it('on civitai.red, still counts and shows every mature item', async () => {
    const { total, byCollection } = await getPendingCollectionReviewCounts({
      userId: CONTEST_MANAGER,
      levels: ALL,
    });

    expect(byCollection).toEqual({ [MATURE_ONLY]: 3, [MIXED]: 2 });
    expect(total).toBe(5);
    expect(await queueIds(MATURE_ONLY, ALL)).toEqual([601, 602, 603]);
    expect(await queueIds(MIXED, ALL)).toEqual([701, 702]);
  });
});
