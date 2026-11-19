import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import {
  allBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { MediaType } from '~/shared/utils/prisma/enums';

// getMyImages' own `where`, run by Prisma against real Postgres (PGlite): a scanned image in a
// published post that is held for review leaves its owner's list.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { getMyImages } = await import('~/server/services/image.service');

const OWNER = 10;
const POST = 1000;
const CLEAN = 1;
const HELD_CSAM = 2;
const HELD_MINOR = 3;
const OTHER_REVIEW = 4;

const SCHEMA = `
  CREATE TYPE "ImageIngestionStatus" AS ENUM
    ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
  CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3));
  CREATE TABLE "Image" (
    id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, url text NOT NULL DEFAULT '',
    meta jsonb, metadata jsonb NOT NULL DEFAULT '{}', "createdAt" timestamp(3) NOT NULL DEFAULT now(),
    type "MediaType" NOT NULL DEFAULT 'image', "nsfwLevel" int NOT NULL DEFAULT 1,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "needsReview" text,
    "tosViolation" boolean NOT NULL DEFAULT false
  );
`;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
  await harness.pg.exec(`
    INSERT INTO "Post" VALUES (${POST}, now() - interval '1 day');
    INSERT INTO "Image" (id, "userId", "postId", "needsReview") VALUES
      (${CLEAN}, ${OWNER}, ${POST}, NULL),
      (${HELD_CSAM}, ${OWNER}, ${POST}, 'csam'),
      (${HELD_MINOR}, ${OWNER}, ${POST}, 'minor'),
      (${OTHER_REVIEW}, ${OWNER}, ${POST}, 'poi');
  `);
  dbMock.dbRead.image.findMany.mockImplementation(((
    ...args: Parameters<typeof harness.prisma.image.findMany>
  ) => harness.prisma.image.findMany(...args)) as never);
});
afterAll(() => harness.stop());

const listedIds = async (publishedOnly?: boolean) => {
  const { items } = await getMyImages({
    userId: OWNER,
    publishedOnly,
    servableLevels: allBrowsingLevelsFlag,
    mediaTypes: [MediaType.image],
    limit: 10,
  });
  return items.map((i) => i.id).sort();
};

describe('getMyImages: images held for review', () => {
  it('leaves held images out of the owner list and keeps every other image', async () => {
    expect(await listedIds()).toEqual([CLEAN, OTHER_REVIEW]);
  });

  it('leaves them out of the published-only list the image pickers ask for', async () => {
    expect(await listedIds(true)).toEqual([CLEAN]);
  });
});

// The list takes no level from the client, so a SFW-capped request (the green domain, a restricted
// region) must not be sent the owner's mature uploads.
describe('getMyImages: the request level cap', () => {
  const CAPPED_OWNER = 20;
  const PG = 11;
  const R = 12;
  const STILL_SCANNING = 13;

  beforeAll(async () => {
    await harness.pg.exec(`
      INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel", ingestion) VALUES
        (${PG}, ${CAPPED_OWNER}, ${POST}, 1, 'Scanned'),
        (${R}, ${CAPPED_OWNER}, ${POST}, 4, 'Scanned'),
        (${STILL_SCANNING}, ${CAPPED_OWNER}, ${POST}, 0, 'Pending');
    `);
  });

  const listed = async (servableLevels: number) => {
    const { items } = await getMyImages({
      userId: CAPPED_OWNER,
      publishedOnly: true,
      servableLevels,
      mediaTypes: [MediaType.image],
      limit: 10,
    });
    return items.map((i) => i.id).sort();
  };

  // Ruled: an unrated upload can be anything, so a capped request is not sent it, the owner's or not.
  it('leaves R and unrated images out on a SFW-capped request', async () => {
    expect(await listed(sfwBrowsingLevelsFlag)).toEqual([PG]);
  });

  it('lists both where the request is not capped', async () => {
    expect(await listed(allBrowsingLevelsFlag)).toEqual([PG, R, STILL_SCANNING]);
  });
});
