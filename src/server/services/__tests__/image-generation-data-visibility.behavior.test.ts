import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as UserService from '~/server/services/user.service';

/**
 * Runs `getImageGenerationData`'s visibility query against an in-process Postgres, so each image
 * state is decided by the real predicate `image.get` uses rather than by a rendered string.
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
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(),
}));

import { getImageGenerationData } from '../image.service';
import { imageResourcesCache } from '~/server/redis/caches';
import { amIBlockedByUser } from '~/server/services/user.service';

const OWNER = 10;
const VIEWER = 20;
const MANAGER = 30;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int DEFAULT 1,
      "needsReview" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb, "scanJobs" jsonb
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
      availability text DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(raw.queryRaw);
});

beforeEach(async () => {
  await db.exec(`TRUNCATE "Image", "Post", "CollectionContributor";`);
  vi.mocked(amIBlockedByUser).mockReset().mockResolvedValue(false);
  vi.spyOn(imageResourcesCache, 'fetch').mockResolvedValue({});
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    hideMeta: false,
    generationProcess: null,
    meta: { prompt: 'a prompt' },
    type: 'image',
    tools: [],
    techniques: [],
  } as never);
});

/** One image (id 1) with the given columns, in post 1 unless `post` is null. */
async function seed({
  image = {},
  post = {},
}: {
  image?: Record<string, string>;
  post?: Record<string, string> | null;
}) {
  const imageCols = {
    id: '1',
    '"userId"': String(OWNER),
    '"postId"': post ? '1' : 'NULL',
    ...image,
  };
  await db.exec(
    `INSERT INTO "Image" (${Object.keys(imageCols).join(', ')}) VALUES (${Object.values(
      imageCols
    ).join(', ')})`
  );
  if (post) {
    const postCols = {
      id: '1',
      '"userId"': String(OWNER),
      '"publishedAt"': `now() - interval '1 day'`,
      ...post,
    };
    await db.exec(
      `INSERT INTO "Post" (${Object.keys(postCols).join(', ')}) VALUES (${Object.values(
        postCols
      ).join(', ')})`
    );
  }
}

type Viewer = { userId?: number; isModerator?: boolean };
const ANON: Viewer = {};
const OTHER: Viewer = { userId: VIEWER };
const SELF: Viewer = { userId: OWNER };
const MOD: Viewer = { userId: VIEWER, isModerator: true };

async function sees(viewer: Viewer) {
  try {
    const data = await getImageGenerationData({ id: 1, ...viewer });
    // The payload itself, so a stubbed early return can't pass as "visible".
    expect(data.meta?.prompt).toBe('a prompt');
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === 'NOT_FOUND') return false;
    throw e;
  }
}

const HIDDEN: Array<[string, Parameters<typeof seed>[0]]> = [
  ['awaiting review', { image: { '"needsReview"': `'minor'` } }],
  ['not yet scanned', { image: { ingestion: `'Pending'` } }],
  ['rated Blocked', { image: { '"nsfwLevel"': '32' } }],
  ['in an unpublished post', { post: { '"publishedAt"': 'NULL' } }],
  ['in a post scheduled for later', { post: { '"publishedAt"': `now() + interval '1 day'` } }],
  ['in a Private post', { post: { availability: `'Private'` } }],
];

describe('getImageGenerationData visibility', () => {
  it('serves an image in a published public post to everyone', async () => {
    await seed({});
    expect(await sees(ANON)).toBe(true);
    expect(await sees(OTHER)).toBe(true);
  });

  it('serves a postless image to everyone, as image.get does for images outside a post', async () => {
    await seed({ post: null });
    expect(await sees(ANON)).toBe(true);
    expect(await sees(OTHER)).toBe(true);
  });

  it('answers NOT_FOUND for an id that does not exist', async () => {
    expect(await sees(MOD)).toBe(false);
  });

  describe.each(HIDDEN)('an image %s', (_label, state) => {
    beforeEach(() => seed(state));

    it('is not found for a signed-out viewer', async () => {
      expect(await sees(ANON)).toBe(false);
    });

    it('is not found for another signed-in user', async () => {
      expect(await sees(OTHER)).toBe(false);
    });

    it('is served to its owner', async () => {
      expect(await sees(SELF)).toBe(true);
    });

    it('is served to a moderator', async () => {
      expect(await sees(MOD)).toBe(true);
    });
  });

  it('serves an unreviewed image to a manager of the collection its post was submitted to', async () => {
    await seed({ image: { '"needsReview"': `'minor'` }, post: { '"collectionId"': '7' } });
    await db.exec(
      `INSERT INTO "CollectionContributor" VALUES (7, ${MANAGER}, ARRAY['MANAGE']::"CollectionContributorPermission"[]),
        (7, ${VIEWER}, ARRAY['ADD']::"CollectionContributorPermission"[])`
    );
    expect(await sees({ userId: MANAGER })).toBe(true);
    expect(await sees(OTHER)).toBe(false);
  });

  it('is not found for a viewer the owner has blocked', async () => {
    await seed({});
    vi.mocked(amIBlockedByUser).mockResolvedValue(true);
    expect(await sees(OTHER)).toBe(false);
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: VIEWER, targetUserId: OWNER });
  });

  it('skips the block check for moderators and signed-out viewers', async () => {
    await seed({});
    vi.mocked(amIBlockedByUser).mockResolvedValue(true);
    expect(await sees(MOD)).toBe(true);
    expect(await sees(ANON)).toBe(true);
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });
});
