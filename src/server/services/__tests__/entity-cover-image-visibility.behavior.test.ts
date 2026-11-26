import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
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
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TABLE "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, name text, url text, "nsfwLevel" int DEFAULT 1, width int, height int,
      hash text, "hideMeta" boolean DEFAULT false, meta jsonb, "createdAt" timestamp DEFAULT now(),
      "mimeType" text, type text DEFAULT 'image', metadata jsonb, "scannedAt" timestamp,
      "needsReview" text, "blockedFor" text, "userId" int DEFAULT ${OWNER}, index int DEFAULT 0, "postId" int,
      poi boolean, minor boolean, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "modelRestricted" boolean DEFAULT false, "nsfwLevelLocked" boolean DEFAULT false,
      "scanJobs" jsonb, "acceptableMinor" boolean NOT NULL DEFAULT false,
      "tosViolation" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int DEFAULT ${OWNER}, "modelVersionId" int,
      "publishedAt" timestamp, availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "userId" int DEFAULT ${OWNER}, status text,
      "publishedAt" timestamp, ingestion text DEFAULT 'Scanned', "bannerId" int,
      availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int DEFAULT ${OWNER}, status text,
      availability "Availability" DEFAULT 'Public', mode "ModelModifier",
      minor boolean NOT NULL DEFAULT false, "sfwOnly" boolean NOT NULL DEFAULT false,
      "gallerySettings" jsonb
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
    CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL, "imageId" int, "addedById" int,
      status text NOT NULL
    );
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
    -- 308 and 309 follow the article availability rule: one by its cover, one by a content image.
    INSERT INTO "Image" (id) VALUES (318), (319);
    INSERT INTO "Article" (id, "coverId", status, "publishedAt", availability) VALUES
      (308, 318, 'Published', now(), 'Private'), (309, null, 'Published', now(), 'Private');
    INSERT INTO "ImageConnection" VALUES (319, 309, 'Article');

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
    INSERT INTO "Image" (id, "userId") VALUES (1081, -1), (1082, 0);
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

    -- Flagged images: post 1201's only image; post 1202's first, ahead of a clean one; the first
    -- image of public model 1301; article 1401's cover.
    INSERT INTO "Post" (id, "publishedAt") VALUES
      (1201, now() - interval '1 day'), (1202, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", index, "acceptableMinor") VALUES
      (1211, 1201, 0, true), (1212, 1202, 0, true), (1213, 1202, 1, false);
    INSERT INTO "Model" (id, status) VALUES (1301, 'Published');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES (1311, 1301, 'Published');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt") VALUES
      (1321, 1311, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", index, "acceptableMinor") VALUES
      (1331, 1321, 0, true), (1332, 1321, 1, false);
    INSERT INTO "Image" (id, "acceptableMinor") VALUES (1411, true);
    INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES (1401, 1411, 'Published', now());
    -- Flagged images connected to public bounties, an entry and a published article: 1531 is the
    -- only image of bounty 1521; entry 1523 and article 1541 have a flagged image ahead of a clean one.
    INSERT INTO "Bounty" VALUES (1521, ${OWNER}, 'Public'), (1522, ${OWNER}, 'Public');
    INSERT INTO "BountyEntry" VALUES (1523, 1522, ${OWNER});
    INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES (1541, null, 'Published', now());
    INSERT INTO "Image" (id, "acceptableMinor") VALUES
      (1531, true), (1533, true), (1534, false), (1551, true), (1552, false);
    INSERT INTO "ImageConnection" VALUES
      (1531, 1521, 'Bounty'), (1533, 1523, 'BountyEntry'), (1534, 1523, 'BountyEntry'),
      (1551, 1541, 'Article'), (1552, 1541, 'Article');
    -- Taken-down model 1601 with its version 1611, and archived model 1602 with version 1612.
    INSERT INTO "Model" (id, status, mode) VALUES
      (1601, 'Published', 'TakenDown'), (1602, 'Published', 'Archived');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES
      (1611, 1601, 'Published'), (1612, 1602, 'Published');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt") VALUES
      (1621, 1611, now() - interval '1 day'), (1622, 1612, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId") VALUES (1631, 1621), (1632, 1622);

    -- Songs: post 3901's song is held for csam review (by its lyrics or cover), post 3902's is not.
    INSERT INTO "Post" (id, "publishedAt") VALUES
      (3901, now() - interval '1 day'), (3902, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", type, "needsReview") VALUES
      (3911, 3901, 'audio', 'csam'), (3912, 3902, 'audio', NULL);
    -- Held models, each leading its owner post with an image above its gallery level:
    -- 2001 minor (PG stored), 2101 SFW-only with PG stored, so its PG-13 lead is above it too.
    INSERT INTO "Model" (id, status, minor, "sfwOnly", "gallerySettings") VALUES
      (2001, 'Published', true, false, '{"level": 1}'),
      (2101, 'Published', false, true, '{"level": 1}');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES
      (2011, 2001, 'Published'), (2111, 2101, 'Published');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt") VALUES
      (2021, 2011, now() - interval '1 day'), (2121, 2111, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", index, "nsfwLevel") VALUES
      (2031, 2021, 0, ${NsfwLevel.X}), (2032, 2021, 1, ${NsfwLevel.PG}),
      (2131, 2121, 0, ${NsfwLevel.PG13}), (2132, 2121, 1, ${NsfwLevel.PG});
    -- Controls: unflagged model 2201 leads with an X image; SFW-only model 2301 has no stored
    -- level, so its whole limit applies; minor model 2401 stores X, outside its limit, so its
    -- whole limit applies; minor model 2501 stores a non-numeric level.
    INSERT INTO "Model" (id, status, minor, "sfwOnly", "gallerySettings") VALUES
      (2201, 'Published', false, false, '{"level": 31}'),
      (2301, 'Published', false, true, NULL),
      (2401, 'Published', true, false, '{"level": ${NsfwLevel.X}}'),
      (2501, 'Published', true, false, '{"level": "PG"}');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES
      (2211, 2201, 'Published'), (2311, 2301, 'Published'), (2411, 2401, 'Published'),
      (2511, 2501, 'Published');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt") VALUES
      (2221, 2211, now() - interval '1 day'), (2321, 2311, now() - interval '1 day'),
      (2421, 2411, now() - interval '1 day'), (2521, 2511, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", index, "nsfwLevel") VALUES
      (2231, 2221, 0, ${NsfwLevel.X}),
      (2331, 2321, 0, ${NsfwLevel.R}), (2332, 2321, 1, ${NsfwLevel.PG13}),
      (2431, 2421, 0, ${NsfwLevel.X}), (2432, 2421, 1, ${NsfwLevel.PG13}),
      (2531, 2521, 0, ${NsfwLevel.X}), (2532, 2521, 1, ${NsfwLevel.PG13});
    -- Public bounty 2701 links the minor model's X image and its PG one; model 2801 stores a
    -- level beyond int range.
    INSERT INTO "Bounty" VALUES (2701, ${OWNER}, 'Public');
    INSERT INTO "ImageConnection" VALUES (2031, 2701, 'Bounty'), (2032, 2701, 'Bounty');
    INSERT INTO "Model" (id, status, minor, "gallerySettings") VALUES
      (2801, 'Published', true, '{"level": 1e40}');
    INSERT INTO "ModelVersion" (id, "modelId", status) VALUES (2811, 2801, 'Published');
    INSERT INTO "Post" (id, "modelVersionId", "publishedAt") VALUES (2821, 2811, now() - interval '1 day');
    INSERT INTO "Image" (id, "postId", index, "nsfwLevel") VALUES
      (2831, 2821, 0, ${NsfwLevel.X}), (2832, 2821, 1, ${NsfwLevel.PG13});
    -- Article 2901's cover is the minor model's X image; article 2902's the unflagged model's.
    INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES
      (2901, 2031, 'Published', now()), (2902, 2231, 'Published', now());
    -- Article 2903's cover is the taken-down model's image.
    INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES (2903, 1631, 'Published', now());
    -- Articles 2904-2906: a blocked cover, a ToS-violating cover, and an R cover on a restricted
    -- base model, none on a post.
    INSERT INTO "Image" (id, "blockedFor", "tosViolation", "nsfwLevel", "modelRestricted") VALUES
      (2914, 'tos', false, 1, false), (2915, NULL, true, 1, false), (2916, NULL, false, ${NsfwLevel.R}, true);
    INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES
      (2904, 2914, 'Published', now()), (2905, 2915, 'Published', now()), (2906, 2916, 'Published', now());
    -- An X image on published post 201, which is on no model.
    INSERT INTO "Image" (id, "postId", "nsfwLevel") VALUES (2631, 201, ${NsfwLevel.X});
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
const coverOf = async (entityType: string, entityId: number, viewer: Viewer, music = false) => {
  const covers = await getEntityCoverImage({
    entities: [{ entityType, entityId }],
    viewer,
    music,
  });
  return covers[0]?.id ?? null;
};

const hidden: [string, string, number, number][] = [
  ['a Private bounty', 'Bounty', 1, 101],
  ['a taken-down model', 'Model', 1601, 1631],
  ["a taken-down model's version", 'ModelVersion', 1611, 1631],
  ["a taken-down model's image", 'Image', 1631, 1631],
  ["a post on a taken-down model's version", 'Post', 1621, 1631],
  ["an article whose cover is a taken-down model's image", 'Article', 2903, 1631],
  ['an article whose cover violates the ToS', 'Article', 2905, 2915],
  ['a flagged image', 'Image', 1211, 1211],
  ['a post whose only image is flagged', 'Post', 1201, 1211],
  ['an article whose cover is flagged', 'Article', 1401, 1411],
  ['a public bounty whose only image is flagged', 'Bounty', 1521, 1531],
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
  ['an article following the availability rule, by its cover', 'Article', 308, 318],
  ['an article following the availability rule, by a content image', 'Article', 309, 319],
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
  ['a post whose first image is flagged', 'Post', 1202, 1213, 1212],
  ['a public model whose first image is flagged', 'Model', 1301, 1332, 1331],
  ['a version whose first image is flagged', 'ModelVersion', 1311, 1332, 1331],
  ['an entry on a public bounty whose first image is flagged', 'BountyEntry', 1523, 1534, 1533],
  ['a published article whose first content image is flagged', 'Article', 1541, 1552, 1551],
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
  ['a postless image owned by -1', 'Image', 1081, 1081, -1],
  ['a postless image owned by 0', 'Image', 1082, 1082, 0],
];

describe('getEntityCoverImage respects the parent entity visibility', () => {
  describe('an article whose cover is blocked', () => {
    it.each(['anonymous', 'stranger', 'owner'] as const)('has no cover for the %s', async (who) => {
      expect(await coverOf('Article', 2904, viewers[who])).toBeNull();
    });
    it('keeps its cover for a moderator', async () => {
      expect(await coverOf('Article', 2904, viewers.moderator)).toBe(2914);
    });
  });

  describe('a blocked image as its own cover', () => {
    it.each(['anonymous', 'stranger', 'owner'] as const)('has no cover for the %s', async (who) => {
      expect(await coverOf('Image', 2914, viewers[who])).toBeNull();
    });
    it('keeps its cover for a moderator', async () => {
      expect(await coverOf('Image', 2914, viewers.moderator)).toBe(2914);
    });
    it("CONTROL: an unblocked image of the owner's is its own cover for them", async () => {
      expect(await coverOf('Image', 1135, viewers.owner)).toBe(1135);
    });
  });

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

  it.each(['anonymous', 'stranger'] as const)(
    'keeps the covers of an archived model, its version, image and post for a %s viewer',
    async (who) => {
      expect(await coverOf('Model', 1602, viewers[who])).toBe(1632);
      expect(await coverOf('ModelVersion', 1612, viewers[who])).toBe(1632);
      expect(await coverOf('Image', 1632, viewers[who])).toBe(1632);
      expect(await coverOf('Post', 1622, viewers[who])).toBe(1632);
    }
  );

  it.each(Object.keys(viewers) as (keyof typeof viewers)[])(
    'gives a post no cover from a song held for csam review, for a %s viewer with the music flag',
    async (who) => {
      expect(await coverOf('Post', 3901, viewers[who], true)).toBeNull();
      expect(await coverOf('Post', 3902, viewers[who], true)).toBe(3912);
    }
  );

  it.each([
    ['anonymous', null],
    ['stranger', null],
    ['owner', 3912],
    ['moderator', 3912],
  ] as const)(
    'gives a post a song cover without the music flag only for its owner and moderators: %s',
    async (who, cover) => {
      expect(await coverOf('Post', 3902, viewers[who])).toBe(cover);
      expect(await coverOf('Image', 3912, viewers[who])).toBe(cover);
    }
  );

  // A held first image falls back to the next one within the gallery level; the owner and
  // moderators see the first.
  describe.each([
    ['a minor model', 'Model', 2001, 2031, 2032],
    ["a minor model's version", 'ModelVersion', 2011, 2031, 2032],
    ["a post on a minor model's version", 'Post', 2021, 2031, 2032],
    ['an SFW-only model held to PG', 'Model', 2101, 2131, 2132],
  ] as const)('%s', (_, entityType, entityId, heldImage, withinImage) => {
    it.each(['anonymous', 'stranger'] as const)(
      'falls back to the image within its gallery level for a %s viewer',
      async (who) => {
        expect(await coverOf(entityType, entityId, viewers[who])).toBe(withinImage);
      }
    );
    it.each(['owner', 'moderator'] as const)('keeps the first image for the %s', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBe(heldImage);
    });
  });

  describe.each([
    ['an unflagged model', 'Model', 2201, 2231],
    ["an unflagged model's version", 'ModelVersion', 2211, 2231],
    ["a post on an unflagged model's version", 'Post', 2221, 2231],
    ["an unflagged model's image", 'Image', 2231, 2231],
    ['an image on a post on no model', 'Image', 2631, 2631],
    ['an SFW-only model with no stored level', 'Model', 2301, 2332],
    ['a minor model whose stored level is outside its limit', 'Model', 2401, 2432],
    ['a minor model whose stored level is not a number', 'Model', 2501, 2532],
    ['a minor model whose stored level is beyond int range', 'Model', 2801, 2832],
    ["a bounty linking a minor model's image above its gallery level", 'Bounty', 2701, 2032],
    ["an article whose cover is an unflagged model's image", 'Article', 2902, 2231],
  ] as const)('%s', (_, entityType, entityId, imageId) => {
    it.each(['anonymous', 'stranger'] as const)(
      'has the cover %s viewers are served',
      async (who) => {
        expect(await coverOf(entityType, entityId, viewers[who])).toBe(imageId);
      }
    );
  });

  it.each(['anonymous', 'stranger'] as const)(
    "has no cover for a minor model's image above its gallery level, for a %s viewer",
    async (who) => {
      expect(await coverOf('Image', 2031, viewers[who])).toBeNull();
      expect(await coverOf('Image', 2032, viewers[who])).toBe(2032);
    }
  );

  it.each(['owner', 'moderator'] as const)(
    "keeps a minor model's image above its gallery level for the %s",
    async (who) => {
      expect(await coverOf('Image', 2031, viewers[who])).toBe(2031);
    }
  );

  it.each(['anonymous', 'stranger'] as const)(
    "has no cover for an article whose cover is a minor model's image above its gallery level, for a %s viewer",
    async (who) => {
      expect(await coverOf('Article', 2901, viewers[who])).toBeNull();
    }
  );

  it.each(['owner', 'moderator'] as const)(
    "keeps an article cover above its model's gallery level for the %s",
    async (who) => {
      expect(await coverOf('Article', 2901, viewers[who])).toBe(2031);
    }
  );

  // Its uploader keeps it, as in 'keeps the restricted cover for its uploader' below.
  it.each(['anonymous', 'stranger', 'moderator'] as const)(
    'has no cover for an article whose R cover is on a restricted base model, for the %s',
    async (who) => {
      expect(await coverOf('Article', 2906, viewers[who])).toBeNull();
    }
  );

  // An unrated image is its moderators' alone: never a cover for anyone else, owner included.
  describe.each(visible)('%s whose cover image is unrated', (_, entityType, entityId, imageId) => {
    let level: number;
    beforeEach(async () => {
      const { rows } = await db.query<{ nsfwLevel: number }>(
        `SELECT "nsfwLevel" FROM "Image" WHERE id = $1`,
        [imageId]
      );
      level = rows[0].nsfwLevel;
      await db.query(`UPDATE "Image" SET "nsfwLevel" = 0 WHERE id = $1`, [imageId]);
    });
    afterEach(async () => {
      await db.query(`UPDATE "Image" SET "nsfwLevel" = $2 WHERE id = $1`, [imageId, level]);
    });
    it.each(['anonymous', 'stranger', 'owner'] as const)(
      'is not the cover for the %s',
      async (who) => {
        expect(await coverOf(entityType, entityId, viewers[who])).not.toBe(imageId);
      }
    );
    it('is still the cover for a moderator', async () => {
      expect(await coverOf(entityType, entityId, viewers.moderator)).toBe(imageId);
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

describe('getEntityCoverImage withholds mature images on a restricted base model', () => {
  beforeAll(async () => {
    // Article 1701's cover is restricted mature, article 1702's cover restricted but SFW. Public
    // bounty 1721 has a restricted mature image ahead of a clean one.
    await db.exec(`
      INSERT INTO "Image" (id, "nsfwLevel", "modelRestricted") VALUES
        (1711, 8, true), (1712, 1, true), (1731, 16, true), (1732, 8, false);
      INSERT INTO "Post" (id, "publishedAt") VALUES (1751, now() - interval '1 day');
      INSERT INTO "Image" (id, "postId", "nsfwLevel", "modelRestricted") VALUES (1741, 1751, 4, true);
      INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES
        (1701, 1711, 'Published', now()), (1702, 1712, 'Published', now());
      INSERT INTO "Bounty" VALUES (1721, ${OWNER}, 'Public');
      INSERT INTO "ImageConnection" VALUES (1731, 1721, 'Bounty'), (1732, 1721, 'Bounty');
    `);
  });

  it.each(['anonymous', 'stranger', 'moderator'] as const)(
    'gives a %s viewer no restricted cover',
    async (who) => {
      expect(await coverOf('Article', 1701, viewers[who])).toBeNull();
      expect(await coverOf('Bounty', 1721, viewers[who])).toBe(1732);
    }
  );

  it.each(['stranger', 'moderator'] as const)(
    'gives a %s no restricted Image-entity cover',
    async (who) => {
      expect(await coverOf('Image', 1741, viewers[who])).toBeNull();
    }
  );

  it('keeps the restricted cover for its uploader', async () => {
    expect(await coverOf('Article', 1701, viewers.owner)).toBe(1711);
    expect(await coverOf('Image', 1741, viewers.owner)).toBe(1741);
    expect(await coverOf('Bounty', 1721, viewers.owner)).toBe(1731);
  });

  it.each(Object.keys(viewers) as (keyof typeof viewers)[])(
    'keeps a SFW cover on a restricted base model for a %s viewer',
    async (who) => {
      expect(await coverOf('Article', 1702, viewers[who])).toBe(1712);
    }
  );
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

describe('a blocked or ToS-violating bounty image', () => {
  beforeAll(async () => {
    // Bounty 3001 leads with a blocked image, then a clean one; bounty 3002's only image violates
    // the ToS. Entry 3003, on public bounty 2, leads with a blocked image, then a clean one. Bounty
    // 3004 leads with an image held for its metadata, then a clean one.
    await db.exec(`
      INSERT INTO "Image" (id, "blockedFor", "tosViolation") VALUES
        (3011, 'tos', false), (3012, NULL, false), (3013, NULL, true),
        (3014, 'tos', false), (3015, NULL, false), (3016, 'AiNotVerified', false),
        (3017, NULL, false);
      INSERT INTO "Bounty" VALUES (3001, ${OWNER}, 'Public'), (3002, ${OWNER}, 'Public'),
        (3004, ${OWNER}, 'Public');
      INSERT INTO "BountyEntry" VALUES (3003, 2, ${OWNER});
      INSERT INTO "ImageConnection" VALUES
        (3011, 3001, 'Bounty'), (3012, 3001, 'Bounty'), (3013, 3002, 'Bounty'),
        (3014, 3003, 'BountyEntry'), (3015, 3003, 'BountyEntry'), (3016, 3004, 'Bounty'),
        (3017, 3004, 'Bounty');
    `);
  });

  // [label, entityType, entityId, cover for anonymous/stranger, for the owner, for a moderator]
  // The owner column split from the moderator one in civitai/civitai#10505: a block refuses the owner too.
  const cases: [string, string, number, number | null, number, number][] = [
    ["a bounty's first connected image, blocked", 'Bounty', 3001, 3012, 3012, 3011],
    ["a bounty's only image, violating the ToS", 'Bounty', 3002, null, 3013, 3013],
    ["an entry's first connected image, blocked", 'BountyEntry', 3003, 3015, 3015, 3014],
    ["a bounty's first connected image, held for its metadata", 'Bounty', 3004, 3017, 3016, 3016],
  ];

  describe.each(cases)('as %s', (_, entityType, entityId, othersSee, ownerSees, modSees) => {
    it.each(['anonymous', 'stranger'] as const)('is passed over for a %s viewer', async (who) => {
      expect(await coverOf(entityType, entityId, viewers[who])).toBe(othersSee);
    });

    it('is kept for the owner only where the block leaves them the media', async () => {
      expect(await coverOf(entityType, entityId, viewers.owner)).toBe(ownerSees);
    });

    it('is kept for a moderator', async () => {
      expect(await coverOf(entityType, entityId, viewers.moderator)).toBe(modSees);
    });
  });
});

describe('a cover at the Blocked level with no block recorded', () => {
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO "Image" (id, "blockedFor", "nsfwLevel") VALUES (3022, NULL, ${NsfwLevel.Blocked});
      INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES (3032, 3022, 'Published', now());
    `);
  });

  it.each(['anonymous', 'stranger', 'owner'] as const)('is no cover for the %s', async (who) => {
    expect(await coverOf('Article', 3032, viewers[who])).toBeNull();
  });
});

describe("a bounty's image listed on a report", () => {
  // Bounty 3101's images: 3111 listed (as an object entry) and owned by OWNER, 3112 unlisted.
  // Entry 3102's images: 3113 listed (as a string entry) and owned by OWNER, 3114 unlisted.
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO "Bounty" VALUES (3101, ${OWNER}, 'Public');
      INSERT INTO "BountyEntry" VALUES (3102, 3101, 50);
      INSERT INTO "Image" (id) VALUES (3111), (3112), (3113), (3114);
      INSERT INTO "ImageConnection" VALUES
        (3111, 3101, 'Bounty'), (3112, 3101, 'Bounty'),
        (3113, 3102, 'BountyEntry'), (3114, 3102, 'BountyEntry');
      INSERT INTO "CsamReport" ("userId", images) VALUES (${OWNER}, '[{"id": 3111}, "3113"]');
    `);
  });

  const coverFor = async (
    viewer: Viewer,
    seesReportListed?: boolean,
    entity: { entityType: 'Bounty' | 'BountyEntry'; entityId: number } = {
      entityType: 'Bounty',
      entityId: 3101,
    }
  ) => {
    const covers = await getEntityCoverImage({
      // BountyEntry is outside the request schema's entity types; the query serves it all the same.
      entities: [entity] as Parameters<typeof getEntityCoverImage>[0]['entities'],
      viewer,
      seesReportListed,
    });
    return covers[0]?.id ?? null;
  };

  // The bounty search index drops these images; a moderator needs the held-media grant too.
  it.each(['anonymous', 'stranger', 'moderator'] as const)(
    'is passed over for the %s',
    async (who) => {
      expect(await coverFor(viewers[who])).toBe(3112);
    }
  );

  it('is kept for its uploader', async () => {
    expect(await coverFor(viewers.owner)).toBe(3111);
  });

  it('is kept for a viewer who sees report-listed images', async () => {
    expect(await coverFor(viewers.moderator, true)).toBe(3111);
  });

  // Entries follow their bounty's rule (#10483), so an entry's listed image is passed over too.
  const entry = { entityType: 'BountyEntry', entityId: 3102 } as const;

  it.each(['anonymous', 'stranger', 'moderator'] as const)(
    "passes over an entry's listed image for the %s",
    async (who) => {
      expect(await coverFor(viewers[who], undefined, entry)).toBe(3114);
    }
  );

  it("keeps an entry's listed image for its uploader", async () => {
    expect(await coverFor(viewers.owner, undefined, entry)).toBe(3113);
  });

  it("keeps an entry's listed image for a viewer who sees report-listed images", async () => {
    expect(await coverFor(viewers.moderator, true, entry)).toBe(3113);
  });
});

describe("an article's cover listed on a report", () => {
  // Article 3201's cover 3211 is listed and owned by OWNER; 3212, a content image, is not.
  beforeAll(async () => {
    await db.exec(`
      INSERT INTO "Image" (id) VALUES (3211), (3212);
      INSERT INTO "Article" (id, "coverId", status, "publishedAt") VALUES (3201, 3211, 'Published', now());
      INSERT INTO "ImageConnection" VALUES (3212, 3201, 'Article');
      INSERT INTO "CsamReport" ("userId", images) VALUES (${OWNER}, '[{"id": 3211}]');
    `);
  });

  const articleCover = async (viewer: Viewer, seesReportListed?: boolean) => {
    const covers = await getEntityCoverImage({
      entities: [{ entityType: 'Article', entityId: 3201 }],
      viewer,
      seesReportListed,
    });
    return covers[0]?.id ?? null;
  };

  // Articles follow the bounty rule (#10485): the next image stands in for the listed cover.
  it.each(['anonymous', 'stranger', 'moderator'] as const)(
    'is passed over for the %s',
    async (who) => {
      expect(await articleCover(viewers[who])).toBe(3212);
    }
  );

  it('is kept for its uploader', async () => {
    expect(await articleCover(viewers.owner)).toBe(3211);
  });

  it('is kept for a viewer who sees report-listed images', async () => {
    expect(await articleCover(viewers.moderator, true)).toBe(3211);
  });
});
