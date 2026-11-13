import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as UserService from '~/server/services/user.service';

/**
 * `image.getDetail` reads resources and tags from caches keyed by image id alone, so it answers
 * only for an image the viewer could open with `image.get`. Runs the procedure against an
 * in-process Postgres so each image state is decided by the real visibility predicate.
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
// The viewer's own tag votes; not what decides visibility.
vi.mock('@civitai/db-queries/tag', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listImageTagVotes: vi.fn(async () => []),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(),
}));

import { imageRouter } from '~/server/routers/image.router';
import { tagRouter } from '~/server/routers/tag.router';
import { imageResourcesCache, imageTagsCache } from '~/server/redis/caches';
import { amIBlockedByUser } from '~/server/services/user.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

// assertImageVisibleToViewer reads through Kysely, not Prisma's `$queryRaw`. Its statements get the
// answers this file's `$queryRaw` fakes give, without counting as `$queryRaw` calls (answerLike).
vi.mock('~/server/db/kyselyDb.lazy', async () => {
  const { fakeKyselyDbLazy, answerLike } = await import('~/test-utils/kysely-raw-fake');
  const { dbMock } = await import('~/__tests__/mocks/db.mock');
  return fakeKyselyDbLazy(
    answerLike(dbMock.dbRead.$queryRaw),
    answerLike(dbMock.dbWrite.$queryRaw)
  );
});

const OWNER = 10;
const VIEWER = 20;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TABLE "TextScanHold" ("entityType" text, "entityId" int, label text, status text);
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" ( type "MediaType" NOT NULL DEFAULT 'image',
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int DEFAULT 1,
      "needsReview" text, "blockedFor" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}',
      "scanJobs" jsonb, "acceptableMinor" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text,
      "bannerId" int
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Bounty" (
      id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
  `);
  const raw = pgliteRaw(db);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      Array.isArray(first)
        ? raw.queryRaw(first as TemplateStringsArray, ...values)
        : (await db.query((first as Prisma.Sql).text, (first as Prisma.Sql).values)).rows
  );
});

beforeEach(async () => {
  await db.exec(`TRUNCATE "Image", "Post";`);
  vi.mocked(amIBlockedByUser).mockReset().mockResolvedValue(false);
  vi.spyOn(imageResourcesCache, 'fetch').mockResolvedValue({
    1: { resources: [{ modelVersionId: 5, versionName: 'v1', detected: true }] },
  } as never);
  vi.spyOn(imageTagsCache, 'fetch').mockResolvedValue({
    1: { tags: [{ tagId: 7, tagName: 'tag', automated: true, concrete: true }] },
  } as never);
});

/** Image 1 owned by OWNER, in published post 1 unless `post` is null. */
async function seed({
  image = {},
  post = {},
}: {
  image?: Record<string, string>;
  post?: Record<string, string> | null;
} = {}) {
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

type User = { id: number; isModerator?: boolean } | undefined;
const ANON: User = undefined;
const STRANGER: User = { id: VIEWER };
const SELF: User = { id: OWNER };
const MOD: User = { id: VIEWER, isModerator: true };

function callerFor(user: User) {
  return imageRouter.createCaller({
    user,
    acceptableOrigin: true,
    tokenScope: TokenScope.Full,
    apiKeyId: null,
    req: { headers: {} },
    res: { setHeader: () => undefined },
    cache: { edgeTTL: 0 },
    features: { canViewNsfw: true },
    track: { action: vi.fn(() => Promise.resolve(true)) },
  } as never);
}

async function sees(user: User, id = 1) {
  try {
    const data = await callerFor(user).getDetail({ id });
    expect(data.resources).toEqual([
      { id: 5, modelVersion: { id: 5, name: 'v1' }, detected: true },
    ]);
    expect(data.tags[0].tag.name).toBe('tag');
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === 'NOT_FOUND') return false;
    throw e;
  }
}

async function errorOf(user: User, id: number) {
  const e = await callerFor(user)
    .getDetail({ id })
    .then(
      () => undefined,
      (err: unknown) => err
    );
  expect(e).toBeDefined();
  const { name, code, message } = e as { name: string; code: string; message: string };
  return JSON.stringify({ name, code, message, keys: Object.keys(e as object).sort() });
}

const HIDDEN: Array<[string, Parameters<typeof seed>[0]]> = [
  ['blocked for a policy reason', { image: { '"blockedFor"': `'tos'` } }],
  ['rated Blocked', { image: { '"nsfwLevel"': '32' } }],
  ['flagged acceptableMinor', { image: { '"acceptableMinor"': 'true' } }],
  ['awaiting review', { image: { '"needsReview"': `'minor'` } }],
  ['in an unpublished post', { post: { '"publishedAt"': 'NULL' } }],
  ['in a Private post', { post: { availability: `'Private'` } }],
  ['with no post', { post: null }],
];

describe('image.getDetail visibility', () => {
  it('a visible image answers to anyone, signed out included', async () => {
    await seed();
    expect(await sees(ANON)).toBe(true);
    expect(await sees(STRANGER)).toBe(true);
  });

  it.each(HIDDEN)('an image %s is NOT_FOUND to a stranger and signed out', async (_, state) => {
    await seed(state);
    expect(await sees(STRANGER)).toBe(false);
    expect(await sees(ANON)).toBe(false);
  });

  it.each(HIDDEN)('an image %s still answers to its owner and a moderator', async (_, state) => {
    await seed(state);
    expect(await sees(SELF)).toBe(true);
    expect(await sees(MOD)).toBe(true);
  });

  it('a stranger the owner blocked gets NOT_FOUND; a moderator is not block-checked', async () => {
    await seed();
    vi.mocked(amIBlockedByUser).mockResolvedValue(true);
    expect(await sees(STRANGER)).toBe(false);
    expect(amIBlockedByUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: VIEWER, targetUserId: OWNER })
    );
    expect(await sees(MOD)).toBe(true);
  });

  it('a hidden image fails exactly like an id that does not exist', async () => {
    await seed({ post: { '"publishedAt"': 'NULL' } });
    const hidden = await errorOf(STRANGER, 1);
    const missing = await errorOf(STRANGER, 999);
    expect(hidden).toBe(missing);
    expect(JSON.parse(hidden).code).toBe('NOT_FOUND');
  });
});

describe('tag.getVotableTags on an image', () => {
  function tagCallerFor(user: User) {
    return tagRouter.createCaller({
      user,
      acceptableOrigin: true,
      tokenScope: TokenScope.Full,
      apiKeyId: null,
      req: { headers: {} },
      res: { setHeader: () => undefined },
      cache: { edgeTTL: 0 },
      features: { canViewNsfw: true },
      track: { action: vi.fn(() => Promise.resolve(true)) },
    } as never);
  }

  async function seesTags(user: User, id = 1) {
    try {
      const tags = await tagCallerFor(user).getVotableTags({ type: 'image', id });
      expect(tags.map((t) => t.name)).toEqual(['tag']);
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'NOT_FOUND') return false;
      throw e;
    }
  }

  it('a visible image returns its tags to anyone', async () => {
    await seed();
    expect(await seesTags(ANON)).toBe(true);
    expect(await seesTags(STRANGER)).toBe(true);
  });

  it.each(HIDDEN)('an image %s is NOT_FOUND to a stranger and signed out', async (_, state) => {
    await seed(state);
    expect(await seesTags(STRANGER)).toBe(false);
    expect(await seesTags(ANON)).toBe(false);
  });

  it.each(HIDDEN)(
    'an image %s still returns tags to its owner and a moderator',
    async (_, state) => {
      await seed(state);
      expect(await seesTags(SELF)).toBe(true);
      expect(await seesTags(MOD)).toBe(true);
    }
  );

  it('a hidden image fails exactly like an id that does not exist, and never as a server error', async () => {
    await seed({ post: { '"publishedAt"': 'NULL' } });
    const errorFor = async (id: number) => {
      const e = await tagCallerFor(STRANGER)
        .getVotableTags({ type: 'image', id })
        .then(
          () => undefined,
          (err: unknown) => err
        );
      expect(e).toBeDefined();
      const { name, code, message } = e as { name: string; code: string; message: string };
      return JSON.stringify({ name, code, message, keys: Object.keys(e as object).sort() });
    };
    const hidden = await errorFor(1);
    expect(hidden).toBe(await errorFor(999));
    expect(JSON.parse(hidden).code).toBe('NOT_FOUND');
  });
});
