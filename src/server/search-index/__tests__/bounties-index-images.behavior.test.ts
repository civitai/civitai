import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as MeiliUtil from '~/server/meilisearch/util';

/**
 * The bounties index has no viewer, so each document carries only the images a signed-out
 * visitor is served on the bounty page, and no generation data the uploader chose to hide.
 * Runs the processor's own pull query against an in-process Postgres.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { onSearchIndexDocumentsCleanup } = vi.hoisted(() => ({
  onSearchIndexDocumentsCleanup: vi.fn(async () => undefined),
}));
vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliUtil>()),
  onSearchIndexDocumentsCleanup,
}));

const { bountiesSearchIndex, transformData } = await import(
  '~/server/search-index/bounties.search-index'
);

const OWNER = 1;
// bounty id = its only image's id
const CLEAN = 10;
const BLOCKED_FOR = 11;
const UNRATED = 12;
const MINOR_R = 13;
const HIDDEN_META = 14;
const TOS_VIOLATION = 15;
const ACCEPTABLE_MINOR = 16;

let pg: PGlite;
const db = {
  $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return pg.query(flat.text, flat.values as unknown[]).then((r) => r.rows);
  },
};

beforeAll(async () => {
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "Bounty" (
      id int PRIMARY KEY, name text DEFAULT 'b', "nsfwLevel" int DEFAULT 1, description text,
      "createdAt" timestamp DEFAULT now(), "updatedAt" timestamp DEFAULT now(), "userId" int NOT NULL,
      "startsAt" timestamp DEFAULT now() - interval '1 day', "expiresAt" timestamp DEFAULT now() + interval '1 day',
      type text DEFAULT 'ModelCreation', details jsonb, complete boolean DEFAULT false,
      nsfw boolean DEFAULT false, availability "Availability" NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "User" (
      id int PRIMARY KEY, username text, "deletedAt" timestamp, image text, "profilePictureId" int
    );
    CREATE TABLE "UserCosmetic" ("userId" int, "cosmeticId" int, data jsonb, "equippedAt" timestamp, "equippedToId" int);
    CREATE TABLE "Cosmetic" (id int, data jsonb, type text, source text, name text, "leaderboardId" text, "leaderboardPosition" int);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL DEFAULT ${OWNER}, index int DEFAULT 0, "postId" int,
      name text, url text NOT NULL DEFAULT 'u', "nsfwLevel" int NOT NULL DEFAULT 1, width int, height int,
      hash text, "createdAt" timestamp DEFAULT now(), "mimeType" text, "scannedAt" timestamp,
      type text DEFAULT 'image', meta jsonb, "hideMeta" boolean NOT NULL DEFAULT false,
      "generationProcess" text, "needsReview" text, minor boolean NOT NULL DEFAULT false,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "blockedFor" text,
      "modelRestricted" boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
      "acceptableMinor" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "Tag" (id int PRIMARY KEY, name text);
    CREATE TABLE "TagsOnBounty" ("bountyId" int, "tagId" int);
    CREATE TABLE "BountyStat" (
      "bountyId" int, "favoriteCountAllTime" int, "trackCountAllTime" int, "entryCountAllTime" int,
      "benefactorCountAllTime" int, "unitAmountCountAllTime" int, "commentCountAllTime" int
    );

    INSERT INTO "User" (id, username, image) VALUES (${OWNER}, 'owner', 'legacy.png');
    INSERT INTO "Image" (id, "tosViolation") VALUES (${TOS_VIOLATION}, true);
    INSERT INTO "Image" (id, "acceptableMinor") VALUES (${ACCEPTABLE_MINOR}, true);
    INSERT INTO "Image" (id, meta, "nsfwLevel", "blockedFor", minor, "hideMeta") VALUES
      (${CLEAN}, '{"prompt": "p"}', 1, NULL, false, false),
      (${BLOCKED_FOR}, NULL, 1, 'tos', false, false),
      (${UNRATED}, NULL, 0, NULL, false, false),
      (${MINOR_R}, NULL, ${NsfwLevel.R}, NULL, true, false),
      (${HIDDEN_META}, '{"prompt": "secret"}', 1, NULL, false, true);
  `);
  for (const id of [
    CLEAN,
    BLOCKED_FOR,
    UNRATED,
    MINOR_R,
    HIDDEN_META,
    TOS_VIOLATION,
    ACCEPTABLE_MINOR,
  ]) {
    await pg.exec(`
      INSERT INTO "Bounty" (id, "userId") VALUES (${id}, ${OWNER});
      INSERT INTO "ImageConnection" VALUES (${id}, ${id}, 'Bounty');
    `);
  }
});
afterAll(() => pg.close());

const pull = async (bountyId: number) => {
  onSearchIndexDocumentsCleanup.mockClear();
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockClear();
  const data = await bountiesSearchIndex.pullData(
    { db, logger: () => undefined, indexName: 'bounties' } as never,
    { type: 'update', ids: [bountyId] } as never
  );
  return (await transformData(data))[0];
};
const indexed = async (bountyId: number) => (await pull(bountyId))?.images ?? [];

describe('bounties search index owner', () => {
  it("carries the owner's profilePictureId but not the legacy image", async () => {
    const user = (await pull(CLEAN))?.user as Record<string, unknown> | undefined;
    expect(user).toHaveProperty('profilePictureId');
    expect(user).toHaveProperty('image', null);
  });
});

describe('bounties search index images', () => {
  it('indexes a scanned, rated, unblocked image with its generation data (control)', async () => {
    const images = await indexed(CLEAN);
    expect(images.map((i) => i.id)).toEqual([CLEAN]);
    expect(images[0].meta).toEqual({ prompt: 'p' });
  });

  it('keeps the document of a bounty with a servable image (control)', async () => {
    expect(await pull(CLEAN)).toBeDefined();
    expect(onSearchIndexDocumentsCleanup).not.toHaveBeenCalled();
  });

  it.each([
    ['carries a block reason', BLOCKED_FOR],
    ['is unrated', UNRATED],
    ['is minor-flagged and rated R', MINOR_R],
    ['violates the ToS', TOS_VIOLATION],
    ['is marked acceptable-minor', ACCEPTABLE_MINOR],
  ])('drops the document of a bounty whose only image %s', async (_, id) => {
    expect(await pull(id)).toBeUndefined();
    expect(onSearchIndexDocumentsCleanup).toHaveBeenCalledWith({
      indexName: 'bounties',
      ids: [id],
    });
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('indexes an image whose generation data is hidden, without that data', async () => {
    const images = await indexed(HIDDEN_META);
    expect(images.map((i) => i.id)).toEqual([HIDDEN_META]);
    expect(images[0].meta).toBeNull();
  });
});
