import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * Runs `getEntityCoverImage`'s real query against an in-process Postgres: a cover respects the
 * parent entity's visibility, the same rule that entity's own page applies, with the owner and
 * moderators still seeing it.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/cosmetic.service', () => ({
  getCosmeticsForEntity: vi.fn().mockResolvedValue({}),
  getEventDecorationsForEntity: vi.fn().mockResolvedValue({}),
}));

import { getEntityCoverImage } from '../image.service';

const OWNER = 10;
const viewers = {
  anonymous: undefined,
  stranger: { id: 20 },
  owner: { id: OWNER },
  moderator: { id: 30, isModerator: true },
};

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, name text, url text, "nsfwLevel" int DEFAULT 1, width int, height int,
      hash text, "hideMeta" boolean DEFAULT false, meta jsonb, "createdAt" timestamp DEFAULT now(),
      "mimeType" text, type text DEFAULT 'image', metadata jsonb, "scannedAt" timestamp,
      "needsReview" text, "userId" int DEFAULT ${OWNER}, index int DEFAULT 0, "postId" int,
      poi boolean, minor boolean, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "modelRestricted" boolean DEFAULT false, "nsfwLevelLocked" boolean DEFAULT false,
      "scanJobs" jsonb
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int DEFAULT ${OWNER}, "modelVersionId" int,
      "publishedAt" timestamp, availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "userId" int DEFAULT ${OWNER}, status text,
      "publishedAt" timestamp, ingestion text DEFAULT 'Scanned'
    );
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int DEFAULT ${OWNER}, status text,
      availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int, index int DEFAULT 0, status text, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "Bounty" (
      id int PRIMARY KEY, "userId" int DEFAULT ${OWNER}, availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );

    -- Bounty 1 is Private, bounty 2 Public. Entry 3 sits on bounty 1, entry 4 on bounty 2.
    INSERT INTO "Bounty" VALUES (1, ${OWNER}, 'Private'), (2, ${OWNER}, 'Public');
    INSERT INTO "BountyEntry" VALUES (3, 1, 50), (4, 2, 50);
    INSERT INTO "Image" (id) VALUES (101), (102), (103), (104);
    INSERT INTO "ImageConnection" VALUES
      (101, 1, 'Bounty'), (102, 2, 'Bounty'), (103, 3, 'BountyEntry'), (104, 4, 'BountyEntry');

    -- Posts: 201 published, 202 scheduled, 203 draft, 204 Private.
    INSERT INTO "Post" (id, "publishedAt", availability) VALUES
      (201, now() - interval '1 day', 'Public'), (202, now() + interval '1 day', 'Public'),
      (203, null, 'Public'), (204, now() - interval '1 day', 'Private');
    INSERT INTO "Image" (id, "postId") VALUES (211, 201), (212, 202), (213, 203), (214, 204);
    -- A postless upload that is no article cover and on no bounty.
    INSERT INTO "Image" (id) VALUES (215);

    -- Articles: 301 published, 302 draft, 303 draft with content images only.
    INSERT INTO "Image" (id) VALUES (311), (312), (313);
    INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES
      (301, 311, 'Published', now()), (302, 312, 'Draft', null), (303, null, 'Draft', null);
    INSERT INTO "ImageConnection" VALUES (313, 303, 'Article');

    -- Models: 401 public, 402 Private, 403 draft. One version and owner post each.
    INSERT INTO "Model" (id, status, availability) VALUES
      (401, 'Published', 'Public'), (402, 'Published', 'Private'), (403, 'Draft', 'Public');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES
      (411, 401, 'Published'), (412, 402, 'Published'), (413, 403, 'Published');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt") VALUES
      (421, 411, now()), (422, 412, now()), (423, 413, now());
    INSERT INTO "Image" (id, "postId") VALUES (431, 421), (432, 422), (433, 423);

    -- Versions on public model 401: 511 Private, 512 scheduled, 513 draft.
    INSERT INTO "ModelVersion" (id, "modelId", status, "publishedAt", availability) VALUES
      (511, 401, 'Published', null, 'Private'),
      (512, 401, 'Scheduled', now() + interval '1 day', 'Public'),
      (513, 401, 'Draft', null, 'Public');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt") VALUES
      (521, 511, now()), (522, 512, now()), (523, 513, now());
    INSERT INTO "Image" (id, "postId") VALUES (531, 521), (532, 522), (533, 523);

    -- Articles with publishedAt set but hidden by status or ingestion: 304/305 by their cover,
    -- 306/307 by content images only.
    INSERT INTO "Image" (id) VALUES (314), (315), (316), (317);
    INSERT INTO "Article" (id, "coverId", status, "publishedAt", ingestion) VALUES
      (304, 314, 'Unpublished', now(), 'Scanned'), (305, 315, 'Published', now(), 'Blocked'),
      (306, null, 'Unpublished', now(), 'Scanned'), (307, null, 'Published', now(), 'Blocked');
    INSERT INTO "ImageConnection" VALUES (316, 306, 'Article'), (317, 307, 'Article');

    -- Public models whose first version or post is hidden, ahead of a visible one:
    -- 601 draft version, 602 scheduled version, 603 Private version, 604 draft post,
    -- 605 Private post, 606 scheduled post.
    INSERT INTO "Model" (id, status) VALUES
      (601, 'Published'), (602, 'Published'), (603, 'Published'),
      (604, 'Published'), (605, 'Published'), (606, 'Published');
    INSERT INTO "ModelVersion" (id, "modelId", index, status, "publishedAt", availability) VALUES
      (611, 601, 0, 'Draft', null, 'Public'), (612, 601, 1, 'Published', null, 'Public'),
      (613, 602, 0, 'Published', now() + interval '1 day', 'Public'),
      (614, 602, 1, 'Published', null, 'Public'),
      (615, 603, 0, 'Published', null, 'Private'), (616, 603, 1, 'Published', null, 'Public'),
      (617, 604, 0, 'Published', null, 'Public'), (618, 605, 0, 'Published', null, 'Public'),
      (619, 606, 0, 'Published', null, 'Public');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt", availability) VALUES
      (621, 611, now() - interval '1 day', 'Public'), (622, 612, now() - interval '1 day', 'Public'),
      (623, 613, now() - interval '1 day', 'Public'), (624, 614, now() - interval '1 day', 'Public'),
      (625, 615, now() - interval '1 day', 'Public'), (626, 616, now() - interval '1 day', 'Public'),
      (627, 617, null, 'Public'), (628, 617, now() - interval '1 day', 'Public'),
      (629, 618, now() - interval '1 day', 'Private'), (630, 618, now() - interval '1 day', 'Public'),
      (631, 619, now() + interval '1 day', 'Public'), (632, 619, now() - interval '1 day', 'Public');
    INSERT INTO "Image" (id, "postId") VALUES
      (641, 621), (642, 622), (643, 623), (644, 624), (645, 625), (646, 626),
      (647, 627), (648, 628), (649, 629), (650, 630), (651, 631), (652, 632);

    -- Published versions of public model 701: 711 only on a draft post, 712 only on a Private
    -- post, 713 with a community post ahead of the owner's.
    INSERT INTO "Model" (id, status) VALUES (701, 'Published');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES
      (711, 701, 'Published'), (712, 701, 'Published'), (713, 701, 'Published');
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt", availability) VALUES
      (721, ${OWNER}, 711, null, 'Public'),
      (722, ${OWNER}, 712, now() - interval '1 day', 'Private'),
      (723, 50, 713, now() - interval '1 day', 'Public'),
      (724, ${OWNER}, 713, now() - interval '1 day', 'Public');
    INSERT INTO "Image" (id, "postId", "userId") VALUES
      (731, 721, ${OWNER}), (732, 722, ${OWNER}), (733, 723, 50), (734, 724, ${OWNER});

    -- Version 714 of public model 701 is Published with a future publishedAt.
    INSERT INTO "ModelVersion" (id, "modelId", status, "publishedAt") VALUES
      (714, 701, 'Published', now() + interval '1 day');
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES
      (725, ${OWNER}, 714, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId") VALUES (735, 725);

    -- Models owned by userId -1, whose versions take covers from other users' posts:
    -- 901 holds a draft version, 902 a published one.
    INSERT INTO "Model" (id, "userId", status) VALUES (901, -1, 'Published'), (902, -1, 'Published');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES (911, 901, 'Draft'), (912, 902, 'Published');
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES
      (921, 50, 911, now() - interval '1 day'), (922, 50, 912, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", "userId") VALUES (931, 921, 50), (932, 922, 50);

    -- Neither Public nor Private: Unsearchable model 951, EarlyAccess version 962 (on model 952),
    -- Unsearchable post 974, Unsearchable bounty 5.
    INSERT INTO "Model" (id, status, availability) VALUES
      (951, 'Published', 'Unsearchable'), (952, 'Published', 'Public');
    INSERT INTO "ModelVersion" (id, "modelId", status, availability) VALUES
      (961, 951, 'Published', 'Public'), (962, 952, 'Published', 'EarlyAccess');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt", availability) VALUES
      (971, 961, now() - interval '1 day', 'Public'), (972, 962, now() - interval '1 day', 'Public'),
      (974, null, now() - interval '1 day', 'Unsearchable');
    INSERT INTO "Image" (id, "postId") VALUES (981, 971), (982, 972), (984, 974);
    INSERT INTO "Bounty" VALUES (5, ${OWNER}, 'Unsearchable');
    INSERT INTO "Image" (id) VALUES (105);
    INSERT INTO "ImageConnection" VALUES (105, 5, 'Bounty');

    -- Hidden entities owned by the placeholder ids -1 and 0, one per owner clause.
    INSERT INTO "Model" (id, "userId", status) VALUES
      (1001, -1, 'Draft'), (1002, 0, 'Draft'), (1003, 0, 'Published');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES
      (1011, 1001, 'Published'), (1012, 1002, 'Published'), (1013, 1003, 'Draft');
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES
      (1021, -1, 1011, now() - interval '1 day'), (1022, 0, 1012, now() - interval '1 day'),
      (1023, 0, 1013, now() - interval '1 day'),
      (1061, -1, null, null), (1062, 0, null, null);
    INSERT INTO "Image" (id, "postId") VALUES
      (1031, 1021), (1032, 1022), (1033, 1023), (1071, 1061), (1072, 1062);
    INSERT INTO "Image" (id) VALUES (1051), (1052), (1053), (1054), (111), (112);
    INSERT INTO "Article" (id, "coverId", "userId", status, "publishedAt") VALUES
      (1041, 1051, -1, 'Draft', null), (1042, 1052, 0, 'Draft', null),
      (1043, null, -1, 'Draft', null), (1044, null, 0, 'Draft', null);
    INSERT INTO "Bounty" VALUES (11, -1, 'Private'), (12, 0, 'Private');
    INSERT INTO "ImageConnection" VALUES
      (1053, 1043, 'Article'), (1054, 1044, 'Article'), (111, 11, 'Bounty'), (112, 12, 'Bounty');

    -- Public model 953 whose only version 963 has only an Unsearchable post.
    INSERT INTO "Model" (id, status) VALUES (953, 'Published');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES (963, 953, 'Published');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt", availability) VALUES
      (975, 963, now() - interval '1 day', 'Unsearchable');
    INSERT INTO "Image" (id, "postId") VALUES (985, 975);

    -- A connection under an entity type no rule covers.
    INSERT INTO "Image" (id) VALUES (801);
    INSERT INTO "ImageConnection" VALUES (801, 9, 'Collection');

    -- Public model 1101 whose first image is minor-flagged and rated R; model 1102 whose only
    -- image is minor-flagged and rated X. Article 1141 and bounty 13 lead with one too.
    INSERT INTO "Model" (id, status) VALUES (1101, 'Published'), (1102, 'Published');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES (1111, 1101, 'Published'), (1112, 1102, 'Published');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt") VALUES
      (1121, 1111, now() - interval '1 day'), (1122, 1112, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", index, "nsfwLevel", minor) VALUES
      (1131, 1121, 0, 4, true), (1132, 1121, 1, 4, false), (1136, 1122, 0, 8, true);
    INSERT INTO "Image" (id, "nsfwLevel", minor) VALUES (1133, 4, true), (1134, 4, true), (1135, 1, NULL);
    INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES (1141, 1133, 'Published', now());
    INSERT INTO "Bounty" VALUES (13, ${OWNER}, 'Public');
    INSERT INTO "ImageConnection" VALUES (1134, 13, 'Bounty'), (1135, 13, 'Bounty');
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

type Viewer = (typeof viewers)[keyof typeof viewers];
const coverOf = async (entityType: string, entityId: number, viewer: Viewer) => {
  const covers = await getEntityCoverImage({ entities: [{ entityType, entityId }], viewer });
  return covers[0]?.id ?? null;
};

const hidden: [string, string, number, number][] = [
  ['a Private bounty', 'Bounty', 1, 101],
  ['an entry on a Private bounty', 'BountyEntry', 3, 103],
  ['an image on a scheduled post', 'Image', 212, 212],
  ['an image on a draft post', 'Image', 213, 213],
  ['an image on a Private post', 'Image', 214, 214],
  ['an image with no post', 'Image', 215, 215],
  ['a scheduled post', 'Post', 202, 212],
  ['a draft post', 'Post', 203, 213],
  ['a Private post', 'Post', 204, 214],
  ['a draft article', 'Article', 302, 312],
  ['a draft article with content images only', 'Article', 303, 313],
  ['a Private model', 'Model', 402, 432],
  ['a draft model', 'Model', 403, 433],
  ['a version of a Private model', 'ModelVersion', 412, 432],
  ['a version of a draft model', 'ModelVersion', 413, 433],
  ['a Private version', 'ModelVersion', 511, 531],
  ['a scheduled version', 'ModelVersion', 512, 532],
  ['a draft version', 'ModelVersion', 513, 533],
  ['an Unpublished article', 'Article', 304, 314],
  ['a Published article whose ingestion is Blocked', 'Article', 305, 315],
  ['an Unpublished article with content images only', 'Article', 306, 316],
  ['a Blocked article with content images only', 'Article', 307, 317],
  ['a published version whose only post is a draft', 'ModelVersion', 711, 731],
  ['a published version whose only post is Private', 'ModelVersion', 712, 732],
  ['a Published version with a future publishedAt', 'ModelVersion', 714, 735],
];

// [label, entityType, entityId, cover for anonymous/stranger, cover for owner/moderator]
const fallback: [string, string, number, number, number][] = [
  ['a public model whose first version is a draft', 'Model', 601, 642, 641],
  ['a public model whose first version is scheduled', 'Model', 602, 644, 643],
  ['a public model whose first version is Private', 'Model', 603, 646, 645],
  ['a public model whose first post is a draft', 'Model', 604, 648, 647],
  ['a public model whose first post is Private', 'Model', 605, 650, 649],
  ['a public model whose first post is scheduled', 'Model', 606, 652, 651],
];

const visible: [string, string, number, number][] = [
  ['a public bounty', 'Bounty', 2, 102],
  ['an entry on a public bounty', 'BountyEntry', 4, 104],
  ['an image on a published post', 'Image', 211, 211],
  ['a published post', 'Post', 201, 211],
  ['a published article', 'Article', 301, 311],
  ['a public model', 'Model', 401, 431],
  ['a published version of a public model', 'ModelVersion', 411, 431],
  ['an Unsearchable model', 'Model', 951, 981],
  ['an EarlyAccess version', 'ModelVersion', 962, 982],
  ['an Unsearchable post', 'Post', 974, 984],
  ['an Unsearchable bounty', 'Bounty', 5, 105],
  ['a version of an Unsearchable model', 'ModelVersion', 961, 981],
  ['a model with an EarlyAccess version', 'Model', 952, 982],
  ['a model whose only post is Unsearchable', 'Model', 953, 985],
  ['a version whose only post is Unsearchable', 'ModelVersion', 963, 985],
];

// Hidden entities whose owner is a placeholder id; [label, entityType, entityId, image, ownerId].
const placeholderOwned: [string, string, number, number, number][] = [
  ['a draft model owned by -1', 'Model', 1001, 1031, -1],
  ['a draft model owned by 0', 'Model', 1002, 1032, 0],
  ['a draft version of a model owned by -1', 'ModelVersion', 911, 931, -1],
  ['a draft version of a model owned by 0', 'ModelVersion', 1013, 1033, 0],
  ['a draft article owned by -1', 'Article', 1041, 1051, -1],
  ['a draft article owned by 0', 'Article', 1042, 1052, 0],
  ['a draft post owned by -1', 'Post', 1061, 1071, -1],
  ['a draft post owned by 0', 'Post', 1062, 1072, 0],
  ['a Private bounty owned by -1', 'Bounty', 11, 111, -1],
  ['a Private bounty owned by 0', 'Bounty', 12, 112, 0],
  ['a draft article with content images only, owned by -1', 'Article', 1043, 1053, -1],
  ['a draft article with content images only, owned by 0', 'Article', 1044, 1054, 0],
];

describe('getEntityCoverImage respects the parent entity visibility', () => {
  describe.each(hidden)('%s', (_, entityType, entityId, imageId) => {
    it.each(['anonymous', 'stranger'] as const)('has no cover for a %s viewer', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBeNull();
    });
    it.each(['owner', 'moderator'] as const)('keeps its cover for the %s', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBe(imageId);
    });
  });

  describe.each(fallback)('%s', (_, entityType, entityId, publicImage, ownerImage) => {
    it.each(['anonymous', 'stranger'] as const)(
      'falls back to the next visible cover for a %s viewer',
      async (who) => {
        expect(await coverOf(entityType, entityId, viewers[who])).toBe(publicImage);
      }
    );
    it.each(['owner', 'moderator'] as const)('keeps the first cover for the %s', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBe(ownerImage);
    });
  });

  it.each(Object.keys(viewers) as (keyof typeof viewers)[])(
    "takes a version's cover from the model owner's post for a %s viewer",
    async (who) => {
      expect(await coverOf('ModelVersion', 713, viewers[who])).toBe(734);
    }
  );

  // A viewer whose id is a placeholder is not signed in, so it owns nothing.
  describe.each(placeholderOwned)('%s', (_, entityType, entityId, imageId, ownerId) => {
    it(`has no cover for a viewer with the placeholder id ${ownerId}`, async () => {
      expect(await coverOf(entityType, entityId, { id: ownerId })).toBeNull();
    });
    it('keeps its cover for a moderator', async () => {
      expect(await coverOf(entityType, entityId, viewers.moderator)).toBe(imageId);
    });
  });

  it('gives a signed-out viewer no cover for a hidden version of a userId -1 model', async () => {
    expect(await coverOf('ModelVersion', 911, viewers.anonymous)).toBeNull();
  });

  it.each(Object.keys(viewers) as (keyof typeof viewers)[])(
    "takes a userId -1 model's version cover from another user's post for a %s viewer",
    async (who) => {
      expect(await coverOf('ModelVersion', 912, viewers[who])).toBe(932);
    }
  );

  it.each(Object.keys(viewers) as (keyof typeof viewers)[])(
    'has no cover through a connection type no rule covers, for a %s viewer',
    async (who) => {
      expect(await coverOf('Collection', 9, viewers[who])).toBeNull();
    }
  );

  describe.each(visible)('%s', (_, entityType, entityId, imageId) => {
    it.each(['anonymous', 'stranger'] as const)('keeps its cover for a %s viewer', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBe(imageId);
    });
  });

  it('treats a missing viewer as anonymous', async () => {
    const covers = await getEntityCoverImage({
      entities: [
        { entityType: 'Bounty', entityId: 1 },
        { entityType: 'Bounty', entityId: 2 },
      ],
    } as Parameters<typeof getEntityCoverImage>[0]);
    expect(covers.map((c) => c.id)).toEqual([102]);
  });
});

describe('a minor-flagged cover rated R or above', () => {
  // [label, entityType, entityId, cover for anonymous/stranger, cover for owner/moderator]
  const cases: [string, string, number, number | null, number][] = [
    ["a model's first image", 'Model', 1101, 1132, 1131],
    ["a version's first image", 'ModelVersion', 1111, 1132, 1131],
    ["a post's first image", 'Post', 1121, 1132, 1131],
    ["a model's only image", 'Model', 1102, null, 1136],
    ["a version's only image", 'ModelVersion', 1112, null, 1136],
    ["an article's cover", 'Article', 1141, null, 1133],
    ["a bounty's first connected image", 'Bounty', 13, 1135, 1134],
    ['an image asked for by id', 'Image', 1131, null, 1131],
  ];

  describe.each(cases)('as %s', (_, entityType, entityId, othersSee, ownerSees) => {
    it.each(['anonymous', 'stranger'] as const)('is passed over for a %s viewer', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBe(othersSee);
    });

    it.each(['owner', 'moderator'] as const)('is kept for the %s', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBe(ownerSees);
    });
  });
});
