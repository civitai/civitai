import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as DbHelpers from '~/server/db/db-helpers';
import type * as FliptClient from '~/server/flipt/client';
import type * as PromClient from '~/server/prom/client';
import type * as RedisCaches from '~/server/redis/caches';
import type { SessionUser } from '~/types/session';

/**
 * Songs are Image rows with type 'audio'. The generic image reads (the image feeds, which every
 * feed route loads its rows through, image.get, post and model-version image lists) serve them
 * only to viewers with the `music` flag (moderators hold it) and to their owner; pictures and
 * videos are served as before. Each read is run, or its song clause is run, against Postgres rows.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { queryWithTimeoutMock, FAN_ID } = vi.hoisted(() => ({
  queryWithTimeoutMock: vi.fn(),
  FAN_ID: 40,
}));

// Flipt answers the `music` flag: on for FAN, off for everyone else.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: async () => undefined,
  isFliptSync: (key: string, entityId?: string) =>
    key === 'music' ? entityId === String(FAN_ID) : null,
}));
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  queryWithTimeout: queryWithTimeoutMock,
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  tagIdsForImagesCache: { fetch: vi.fn().mockResolvedValue({}) },
}));
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  registerCounter: () => ({ inc: vi.fn() }),
}));

import { getAllImages, getImagesForModelVersion, getImagesForPosts } from '../image.service';
import { getImageHandler } from '~/server/controllers/image.controller';
import { imageVisibilityConditions } from '~/server/services/image-visibility.service';

const OWNER = 10;
const STRANGER = 20;
const MOD = 30;
const FAN = FAN_ID; // granted the flag

const PICTURE = 1;
const VIDEO = 2;
const SONG = 3;
const STRANGERS_SONG = 4; // STRANGER's own song
const ALL = [PICTURE, VIDEO, SONG, STRANGERS_SONG];
const NO_SONGS = [PICTURE, VIDEO];

const INT4_OID = 23;
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, name text, url text NOT NULL DEFAULT 'u',
      "nsfwLevel" int NOT NULL DEFAULT 1, width int, height int, hash text, type text DEFAULT 'image',
      metadata jsonb NOT NULL DEFAULT '{}', meta jsonb, "hideMeta" boolean DEFAULT false,
      minor boolean DEFAULT false, poi boolean DEFAULT false, index int,
      "needsReview" text, "acceptableMinor" boolean DEFAULT false,
      ingestion "ImageIngestionStatus" DEFAULT 'Scanned', "nsfwLevelLocked" boolean DEFAULT false,
      "scanJobs" jsonb, "modelRestricted" boolean DEFAULT false, "blockedFor" text,
      "tosViolation" boolean DEFAULT false
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, "bannerId" int, status text, "publishedAt" timestamp, ingestion text, availability "Availability" DEFAULT 'Public', "userId" int
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public');
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);

    INSERT INTO "Model" VALUES (1, ${OWNER});
    INSERT INTO "ModelVersion" VALUES (1, 1);
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES
      (1, ${OWNER}, 1, now() - interval '1 day'),
      (2, ${STRANGER}, 1, now() - interval '1 day');
    INSERT INTO "Image" (id, "userId", "postId", index, type) VALUES
      (${PICTURE}, ${OWNER}, 1, 0, 'image'),
      (${VIDEO}, ${OWNER}, 1, 1, 'video'),
      (${SONG}, ${OWNER}, 1, 2, 'audio'),
      (${STRANGERS_SONG}, ${STRANGER}, 2, 0, 'audio');
  `);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
      const sql = Array.isArray(first)
        ? Prisma.sql(first as TemplateStringsArray, ...values)
        : (first as Prisma.Sql);
      const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
      return (await db.query(sql.text, sql.values, { paramTypes })).rows;
    }
  );
});

afterAll(async () => {
  await db.close();
});

type Viewer = { id: number; isModerator?: boolean } | undefined;
const asUser = (viewer: Viewer) =>
  (viewer ? { isModerator: false, ...viewer } : undefined) as SessionUser | undefined;
const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

const SONG_CLAUSE = /\(i\."type" != 'audio' OR i\."userId" = \$\d+\)|i\."type" != 'audio'/g;

/** The feed statement's song clause, run over the rows above; every id when it has none. */
async function feedRows(viewer: Viewer, input: Record<string, unknown> = {}) {
  queryWithTimeoutMock.mockClear();
  await getAllImages({
    limit: 20,
    period: 'AllTime',
    periodMode: 'published',
    sort: 'Newest',
    browsingLevel: 31,
    include: [],
    user: asUser(viewer),
    asModerator: true,
    asOwner: true,
    ...input,
  } as unknown as Parameters<typeof getAllImages>[0]).catch(() => undefined);
  expect(queryWithTimeoutMock, 'the build no longer reaches queryWithTimeout').toHaveBeenCalled();
  const stmt = queryWithTimeoutMock.mock.calls[0][2] as { text: string; values: unknown[] };
  const clauses = [...stmt.text.matchAll(SONG_CLAUSE)].map((m) => m[0]);
  expect(clauses.length, `more than one song clause in: ${stmt.text}`).toBeLessThanOrEqual(1);
  if (!clauses.length) return ALL;
  const inlined = clauses[0].replace(/\$(\d+)/g, (_, n) => String(stmt.values[Number(n) - 1]));
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM "Image" i WHERE ${inlined} ORDER BY id`
  );
  return ids(rows);
}

beforeEach(() => {
  queryWithTimeoutMock.mockRejectedValue(new Error('stop here'));
});

describe('the image feed (getInfinite, getImagesAsPostsInfinite, v1 images, collections, profiles)', () => {
  it('serves no song to a signed-out viewer', async () => {
    expect(await feedRows(undefined)).toEqual(NO_SONGS);
  });

  it('serves a stranger without the flag only their own song', async () => {
    expect(await feedRows({ id: STRANGER })).toEqual([...NO_SONGS, STRANGERS_SONG]);
  });

  it('serves the owner their songs on their profile', async () => {
    expect(await feedRows({ id: OWNER }, { userId: OWNER })).toEqual([...NO_SONGS, SONG]);
  });

  it('serves no song when a viewer without the flag asks for audio', async () => {
    expect(await feedRows(undefined, { types: ['audio'] })).toEqual(NO_SONGS);
  });

  it('serves every song to a flagged viewer and to a moderator', async () => {
    expect(await feedRows({ id: FAN })).toEqual(ALL);
    expect(await feedRows({ id: MOD, isModerator: true })).toEqual(ALL);
  });

  it('keeps a cached model gallery free of any viewer id', async () => {
    expect(await feedRows({ id: STRANGER }, { modelId: 1 })).toEqual(NO_SONGS);
  });
});

describe('image.get', () => {
  const visibleTo = async (viewer: Viewer, music: boolean) => {
    const raw = pgliteRaw(db);
    const visible: number[] = [];
    for (const id of ALL) {
      const where = Prisma.join(
        [
          Prisma.sql`i.id = ${id}`,
          ...imageVisibilityConditions({
            userId: viewer?.id,
            isModerator: viewer?.isModerator,
            music,
          }),
        ],
        ' AND '
      );
      const rows =
        await raw.queryRaw`SELECT i.id FROM "Image" i LEFT JOIN "Post" p ON p.id = i."postId" WHERE ${where}`;
      if (rows.length) visible.push(id);
    }
    return visible;
  };

  it('opens no song but their own to a viewer without the flag', async () => {
    expect(await visibleTo(undefined, false)).toEqual(NO_SONGS);
    expect(await visibleTo({ id: OWNER }, false)).toEqual([...NO_SONGS, SONG]);
  });

  it('opens every song to a flagged viewer and to a moderator', async () => {
    expect(await visibleTo({ id: STRANGER }, true)).toEqual(ALL);
    expect(await visibleTo({ id: MOD, isModerator: true }, false)).toEqual(ALL);
  });

  // The handler hands the viewer's flag to the read.
  it.each([
    [false, true],
    [true, false],
  ])('the handler, music %s, gates songs: %s', async (music, gated) => {
    const statements: string[] = [];
    const read = dbMock.dbRead.$queryRaw.getMockImplementation();
    dbMock.dbRead.$queryRaw.mockImplementation((async (
      first: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      statements.push(Prisma.sql(first, ...values).text);
      return [];
    }) as never);
    await getImageHandler({
      input: { id: SONG },
      ctx: { user: undefined, features: { music }, req: { headers: {} } } as never,
    }).catch(() => undefined);
    dbMock.dbRead.$queryRaw.mockImplementation(read!);
    const imageRead = statements.find((s) => s.includes('FROM "Image" i'));
    expect(imageRead, 'image.get no longer reads through dbRead.$queryRaw').toBeDefined();
    expect(SONG_CLAUSE.test(imageRead!)).toBe(gated);
    SONG_CLAUSE.lastIndex = 0;
  });
});

describe('post images (getImagesForPosts)', () => {
  const read = async (viewer: Viewer) =>
    ids(await getImagesForPosts({ postIds: [1, 2], user: asUser(viewer), browsingLevel: 31 }));

  it('serves no song but their own to a viewer without the flag', async () => {
    expect(await read(undefined)).toEqual(NO_SONGS);
    expect(await read({ id: OWNER })).toEqual([...NO_SONGS, SONG]);
  });

  it('serves every song to a flagged viewer and to a moderator', async () => {
    expect(await read({ id: FAN })).toEqual(ALL);
    expect(await read({ id: MOD, isModerator: true })).toEqual(ALL);
  });
});

describe('model version images (getImagesForModelVersion)', () => {
  const read = async (viewer?: Viewer) =>
    ids(
      await getImagesForModelVersion({
        modelVersionIds: [1],
        imagesPerVersion: 20,
        user: asUser(viewer),
        browsingLevel: 31,
      })
    );

  it('serves no song without a viewer, as the shared cache reads it', async () => {
    expect(await read()).toEqual(NO_SONGS);
  });

  // The showcase holds the model owner's posts only, so STRANGERS_SONG is never in it.
  it('serves a flagged viewer and the owner the song', async () => {
    expect(await read({ id: FAN })).toEqual([...NO_SONGS, SONG]);
    expect(await read({ id: OWNER })).toEqual([...NO_SONGS, SONG]);
    expect(await read({ id: STRANGER })).toEqual(NO_SONGS);
  });
});
