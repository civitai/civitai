import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as RedisCaches from '~/server/redis/caches';
import type * as UserService from '~/server/services/user.service';

/**
 * A minor-flagged image rated R or above reaches only its owner and moderators on image.get, the
 * model-version image lists and the post lists, whatever browsing settings the client sends. Run
 * against an in-process Postgres so each viewer is judged by the real predicate.
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
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  tagIdsForImagesCache: { fetch: vi.fn().mockResolvedValue({}) },
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn().mockResolvedValue(false),
}));

import {
  getImagesForModelVersion,
  getImagesForPosts,
  imagesForModelVersionsCache,
} from '../image.service';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import {
  assertImageVisibleToViewer,
  imageVisibilityConditions,
} from '~/server/services/image-visibility.service';
import type { SessionUser } from '~/types/session';

const OWNER = 10;
const STRANGER = 20;
const MOD = 30;

const MINOR_R = 1;
const MINOR_X = 2;
const MINOR_PG13 = 3;
const ADULT_R = 4;
const UNFLAGGED_R = 5; // minor is NULL
const MINOR_XXX = 6;
const ALL = [MINOR_R, MINOR_X, MINOR_PG13, ADULT_R, UNFLAGGED_R, MINOR_XXX];
const SHOWN_TO_OTHERS = [MINOR_PG13, ADULT_R, UNFLAGGED_R];
// Version 2's only post holds nothing but minor-flagged mature images.
const ALL_FLAGGED_VERSION = 2;
const ALL_FLAGGED_IMAGES = [7, 8];

// PG | PG13 | R | X | XXX: a viewer who opted into every mature level.
const ALL_MATURE_LEVELS = 31;

const INT4_OID = 23;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, name text, url text NOT NULL DEFAULT 'u',
      "nsfwLevel" int NOT NULL DEFAULT 1, width int, height int, hash text, type text DEFAULT 'image',
      metadata jsonb NOT NULL DEFAULT '{}', meta jsonb, "hideMeta" boolean DEFAULT false,
      minor boolean DEFAULT false, poi boolean DEFAULT false, index int,
      "needsReview" text, "acceptableMinor" boolean DEFAULT false,
      ingestion "ImageIngestionStatus" DEFAULT 'Scanned', "nsfwLevelLocked" boolean DEFAULT false,
      "scanJobs" jsonb, "modelRestricted" boolean DEFAULT false
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public');
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);

    INSERT INTO "Model" VALUES (1, ${OWNER});
    INSERT INTO "ModelVersion" VALUES (1, 1), (${ALL_FLAGGED_VERSION}, 1);
    INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES
      (1, ${OWNER}, 1, now() - interval '1 day'),
      (2, ${OWNER}, ${ALL_FLAGGED_VERSION}, now() - interval '1 day');
    INSERT INTO "Image" (id, "userId", "postId", index, "nsfwLevel", minor) VALUES
      (${MINOR_R}, ${OWNER}, 1, 0, 4, true),
      (${MINOR_X}, ${OWNER}, 1, 1, 8, true),
      (${MINOR_PG13}, ${OWNER}, 1, 2, 2, true),
      (${ADULT_R}, ${OWNER}, 1, 3, 4, false),
      (${UNFLAGGED_R}, ${OWNER}, 1, 4, 4, NULL),
      (${MINOR_XXX}, ${OWNER}, 1, 5, 16, true),
      (${ALL_FLAGGED_IMAGES[0]}, ${OWNER}, 2, 0, 4, true),
      (${ALL_FLAGGED_IMAGES[1]}, ${OWNER}, 2, 1, 8, true);
  `);
  // Typed integer parameters, as Prisma binds them: `unnest(ARRAY[$1])` is text otherwise.
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

type Viewer = { id: number; isModerator?: boolean } | undefined;
const asUser = (viewer: Viewer) => viewer as SessionUser | undefined;

const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

const paths: [string, (viewer: Viewer) => Promise<number[]>][] = [
  [
    'image.get',
    async (viewer) => {
      const raw = pgliteRaw(db);
      const visible: number[] = [];
      for (const id of ALL) {
        const where = Prisma.join(
          [
            Prisma.sql`i.id = ${id}`,
            ...imageVisibilityConditions({ userId: viewer?.id, isModerator: viewer?.isModerator }),
          ],
          ' AND '
        );
        const rows =
          await raw.queryRaw`SELECT i.id FROM "Image" i LEFT JOIN "Post" p ON p.id = i."postId" WHERE ${where}`;
        if (rows.length) visible.push(id);
      }
      return visible;
    },
  ],
  [
    'assertImageVisibleToViewer',
    async (viewer) => {
      const visible: number[] = [];
      for (const id of ALL) {
        const shown = await assertImageVisibleToViewer({
          id,
          userId: viewer?.id,
          isModerator: viewer?.isModerator,
        }).then(
          () => true,
          () => false
        );
        if (shown) visible.push(id);
      }
      return visible;
    },
  ],
  [
    'getImagesForModelVersion',
    async (viewer) =>
      ids(
        await getImagesForModelVersion({
          modelVersionIds: [1],
          imagesPerVersion: 20,
          user: asUser(viewer),
          browsingLevel: ALL_MATURE_LEVELS,
        })
      ),
  ],
  [
    'getImagesForPosts, with disableMinor: false from the client',
    async (viewer) =>
      ids(
        await getImagesForPosts({
          postIds: [1],
          user: asUser(viewer),
          browsingLevel: ALL_MATURE_LEVELS,
          disableMinor: false,
        })
      ),
  ],
];

describe.each(paths)('%s', (_label, visibleTo) => {
  it('hides a minor-flagged image rated R or above from a signed-out viewer', async () => {
    expect(await visibleTo(undefined)).toEqual(SHOWN_TO_OTHERS);
  });

  it('hides it from a signed-in stranger', async () => {
    expect(await visibleTo({ id: STRANGER })).toEqual(SHOWN_TO_OTHERS);
  });

  it('shows it to its owner', async () => {
    expect(await visibleTo({ id: OWNER })).toEqual(ALL);
  });

  it('shows it to a moderator', async () => {
    expect(await visibleTo({ id: MOD, isModerator: true })).toEqual(ALL);
  });
});

describe('getImagesForModelVersion with no viewer, as the shared cache and the v1 REST routes call it', () => {
  it('leaves out a minor-flagged image rated R or above, and keeps one rated PG-13', async () => {
    expect(
      ids(await getImagesForModelVersion({ modelVersionIds: [1], imagesPerVersion: 20 }))
    ).toEqual(SHOWN_TO_OTHERS);
  });
});

describe('imagesForModelVersionsCache', () => {
  it('leaves out a minor-flagged image rated R or above from an entry cached before the lookup did', async () => {
    installFakeCacheRedis();
    const image = (id: number, nsfwLevel: number, minor: boolean | null) => ({
      id,
      userId: OWNER,
      modelVersionId: 9,
      nsfwLevel,
      minor,
    });
    await redis.packed.set(`${REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION}:9` as never, {
      modelVersionId: 9,
      images: [
        image(MINOR_R, 4, true),
        image(MINOR_PG13, 2, true),
        image(ADULT_R, 4, false),
        image(UNFLAGGED_R, 4, null),
      ],
      cachedAt: new Date(),
    });
    await redis.packed.set(`${REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION}:8` as never, {
      modelVersionId: 8,
      images: [image(MINOR_R, 4, true), image(MINOR_X, 8, true)],
      cachedAt: new Date(),
    });

    const cached = await imagesForModelVersionsCache.fetch([9, 8]);
    expect(ids(cached[9].images)).toEqual(SHOWN_TO_OTHERS);
    expect(cached[8]).toEqual({ modelVersionId: 8, images: [] });
  });
});

describe('getImagesForModelVersion for a version whose images are all minor-flagged and mature', () => {
  it('returns its other versions and nothing for it, for a stranger', async () => {
    const rows = await getImagesForModelVersion({
      modelVersionIds: [1, ALL_FLAGGED_VERSION],
      imagesPerVersion: 20,
      user: asUser({ id: STRANGER }),
    });
    expect(rows.some((row) => row.modelVersionId === ALL_FLAGGED_VERSION)).toBe(false);
    expect(ids(rows)).toEqual(SHOWN_TO_OTHERS);
  });

  it('still returns them to the owner (control)', async () => {
    const rows = await getImagesForModelVersion({
      modelVersionIds: [ALL_FLAGGED_VERSION],
      imagesPerVersion: 20,
      user: asUser({ id: OWNER }),
    });
    expect(ids(rows)).toEqual(ALL_FLAGGED_IMAGES);
  });
});

// The v1 model-version routes spread these rows into their response as they are.
describe('getImagesForModelVersion rows for a viewer who cannot see some', () => {
  it('are the rows the owner gets, minus the hidden ones, field for field', async () => {
    const read = (viewer: Viewer) =>
      getImagesForModelVersion({
        modelVersionIds: [1],
        imagesPerVersion: 20,
        include: ['meta'],
        user: asUser(viewer),
      });
    const [ownerRows, strangerRows] = await Promise.all([read({ id: OWNER }), read(undefined)]);
    expect(strangerRows).toEqual(ownerRows.filter((row) => SHOWN_TO_OTHERS.includes(row.id)));
  });
});
