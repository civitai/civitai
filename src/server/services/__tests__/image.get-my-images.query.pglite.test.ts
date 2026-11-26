import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { MediaType } from '~/shared/utils/prisma/enums';

// getMyImages with a typed query (the showcase picker's search), run against real Postgres (PGlite):
// it matches the owner's own images and videos by prompt, post title or post tag.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { getMyImages, OWN_MEDIA_QUERY_WINDOW } = await import('~/server/services/image.service');

const OWNER = 10;
const OTHER_USER = 20;
const TITLED_POST = 1000;
const TAGGED_POST = 1001;
const PLAIN_POST = 1002;
const OTHER_USERS_POST = 2000;
const KURO_TAG = 1;
const SUNSET_TAG = 2;

const VIDEO_BY_POST_TITLE = 1;
const IMAGE_BY_PROMPT = 2;
const IMAGE_BY_POST_TAG = 4;
const UNRELATED = 5;
const DISABLED_POST_TAG_ONLY = 6;
const DISABLED_TAG_POST = 1003;
const OTHER_USERS_MATCH = 9;
const OTHER_USERS_SFW_MATCH = 8;

const SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM
    ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
  CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3), title text);
  CREATE TABLE "Image" (
    id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, url text NOT NULL DEFAULT '',
    meta jsonb, metadata jsonb NOT NULL DEFAULT '{}', "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    type "MediaType" NOT NULL DEFAULT 'image', "nsfwLevel" int NOT NULL DEFAULT 1,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
    "tosViolation" boolean NOT NULL DEFAULT false
  );
  CREATE TABLE "Tag" (id int PRIMARY KEY, name text NOT NULL);
  CREATE TABLE "TagsOnPost" (
    "postId" int NOT NULL, "tagId" int NOT NULL, disabled boolean NOT NULL DEFAULT false
  );
`;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
  await harness.pg.exec(`
    INSERT INTO "Post" VALUES
      (${TITLED_POST}, now() - interval '1 day', 'Kuro at dusk'),
      (${TAGGED_POST}, now() - interval '1 day', NULL),
      (${PLAIN_POST}, now() - interval '1 day', 'Beach day'),
      (${DISABLED_TAG_POST}, now() - interval '1 day', NULL),
      (${OTHER_USERS_POST}, now() - interval '1 day', 'kuro');
    INSERT INTO "Tag" VALUES (${KURO_TAG}, 'kuro'), (${SUNSET_TAG}, 'sunset');
    INSERT INTO "Image" (id, "userId", "postId", type, meta) VALUES
      (${VIDEO_BY_POST_TITLE}, ${OWNER}, ${TITLED_POST}, 'video', NULL),
      (${IMAGE_BY_PROMPT}, ${OWNER}, ${PLAIN_POST}, 'image', '{"prompt": "a KURO cat, 50% off"}'),
      (${IMAGE_BY_POST_TAG}, ${OWNER}, ${TAGGED_POST}, 'image', NULL),
      (${UNRELATED}, ${OWNER}, ${PLAIN_POST}, 'image', '{"prompt": "sunset"}'),
      (${DISABLED_POST_TAG_ONLY}, ${OWNER}, ${DISABLED_TAG_POST}, 'image', NULL),
      (${OTHER_USERS_MATCH}, ${OTHER_USER}, ${OTHER_USERS_POST}, 'image', '{"prompt": "kuro"}');
    UPDATE "Image" SET "nsfwLevel" = 4 WHERE id = ${OTHER_USERS_MATCH};
    INSERT INTO "Image" (id, "userId", "postId", type, meta) VALUES
      (${OTHER_USERS_SFW_MATCH}, ${OTHER_USER}, ${OTHER_USERS_POST}, 'image', '{"prompt": "kuro"}');
    INSERT INTO "TagsOnPost" VALUES
      (${TAGGED_POST}, ${KURO_TAG}, false),
      (${DISABLED_TAG_POST}, ${KURO_TAG}, true),
      (${OTHER_USERS_POST}, ${KURO_TAG}, false);
  `);
  dbMock.dbRead.image.findMany.mockImplementation(((
    ...args: Parameters<typeof harness.prisma.image.findMany>
  ) => harness.prisma.image.findMany(...args)) as never);
  dbMock.dbRead.$queryRaw.mockImplementation(((
    ...args: Parameters<typeof harness.prisma.$queryRaw>
  ) => harness.prisma.$queryRaw(...args)) as never);
});
afterAll(() => harness.stop());

const search = async (query: string, userId = OWNER) => {
  const { items } = await getMyImages({
    userId,
    query,
    publishedOnly: true,
    servableLevels: allBrowsingLevelsFlag,
    mediaTypes: [MediaType.image, MediaType.video],
    limit: 10,
  });
  return items.map((i) => i.id).sort((a, b) => a - b);
};

describe('getMyImages: a typed query', () => {
  it('finds the owner’s video by its post title, and images by prompt or post tag', async () => {
    expect(await search('kuro')).toEqual([VIDEO_BY_POST_TITLE, IMAGE_BY_PROMPT, IMAGE_BY_POST_TAG]);
  });

  // The other user's image matches on every field the query reads.
  it('never returns another user’s media', async () => {
    expect(await search('kuro', OTHER_USER)).toEqual([OTHER_USERS_SFW_MATCH, OTHER_USERS_MATCH]);
    expect(await search('kuro')).not.toContain(OTHER_USERS_MATCH);
    expect(await search('kuro')).not.toContain(OTHER_USERS_SFW_MATCH);
  });

  // The ids only narrow the list: the request's level cap still applies to what they match.
  it('leaves a match above the request’s level cap out', async () => {
    const { items } = await getMyImages({
      userId: OTHER_USER,
      query: 'kuro',
      publishedOnly: true,
      servableLevels: sfwBrowsingLevelsFlag,
      mediaTypes: [MediaType.image],
      limit: 10,
    });
    expect(items.map((i) => i.id)).toEqual([OTHER_USERS_SFW_MATCH]);
  });

  it('reads LIKE wildcards in the query as text', async () => {
    expect(await search('%')).toEqual([IMAGE_BY_PROMPT]);
    expect(await search('_')).toEqual([]);
  });
});

// The match runs over the owner's newest rows only, so a heavy uploader's search stays bounded.
describe('getMyImages: a typed query on a large library', () => {
  const HEAVY_OWNER = 30;
  const OLDEST = 100_000;

  beforeAll(async () => {
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "userId", "postId", meta) VALUES
        (${OLDEST}, ${HEAVY_OWNER}, ${PLAIN_POST}, '{"prompt": "kuro"}');
      INSERT INTO "Image" (id, "userId", "postId", meta)
        SELECT ${OLDEST} + g, ${HEAVY_OWNER}, ${PLAIN_POST}, '{"prompt": "sunset"}'
        FROM generate_series(1, ${OWN_MEDIA_QUERY_WINDOW}) g;
    `);
  });

  it('does not reach a match older than the owner’s newest rows', async () => {
    const { items } = await getMyImages({
      userId: HEAVY_OWNER,
      query: 'kuro',
      publishedOnly: true,
      servableLevels: allBrowsingLevelsFlag,
      mediaTypes: [MediaType.image],
      limit: 10,
    });
    expect(items).toEqual([]);
    // Control: the old match is listed, so only the window keeps it out of the search.
    const { items: all } = await getMyImages({
      userId: HEAVY_OWNER,
      publishedOnly: true,
      servableLevels: allBrowsingLevelsFlag,
      mediaTypes: [MediaType.image],
      cursor: OLDEST,
      limit: 1,
    });
    expect(all.map((i) => i.id)).toEqual([OLDEST]);
  });
});
