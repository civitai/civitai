import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import type * as Flipt from '~/server/flipt/client';

/**
 * The CSAM self-heal job holds the song of a cover removed for CSAM whose song is not held yet, as
 * the scan's block of that cover does. Run through the job's entry point on PGlite. Ids are invented.
 */

vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof Flipt>()),
  isFlipt: async () => false,
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { $query: async () => [], insert: async () => undefined },
}));

const { runCsamBlocklistSelfHeal } = await import('~/server/jobs/csam-blocklist-self-heal');

const OWNER = 990000010;
const OTHER = 990000030;
const MOD = 990000040;
const SONG = 990000101;
const COVER = 990000102;
const PICTURE = 990000103;
const FORGED = 990000106;
const HELD_SONG = 990000111;
const HELD_COVER = 990000112;

const SCHEMA = `
  CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TABLE "Image" (
    id int PRIMARY KEY, type "MediaType" NOT NULL DEFAULT 'image', "userId" int NOT NULL,
    "postId" int, "nsfwLevel" int NOT NULL DEFAULT 1, "needsReview" text, "blockedFor" text,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', metadata jsonb NOT NULL DEFAULT '{}',
    "pHash" bigint, "updatedAt" timestamp(3)
  );
  CREATE TABLE "CsamQueueSetAside" ("imageId" int PRIMARY KEY);
  CREATE TABLE "ModActivity" (
    id serial PRIMARY KEY, "userId" int, "entityType" text, "entityId" int, activity text,
    "createdAt" timestamp(3) NOT NULL DEFAULT now()
  );
  CREATE TABLE "CsamReport" (id serial PRIMARY KEY, "userId" int, images jsonb, "createdAt" timestamp(3));
  CREATE TABLE "BlockedImage" (hash bigint PRIMARY KEY, reason text);
`;

let h: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  h = await startPglitePrisma(SCHEMA);
  const { prisma } = h;
  for (const db of [dbMock.dbRead, dbMock.dbWrite])
    db.$queryRawUnsafe.mockImplementation(((...a: Parameters<typeof prisma.$queryRawUnsafe>) =>
      prisma.$queryRawUnsafe(...a)) as never);
  dbMock.dbWrite.$transaction.mockImplementation(((fn: (tx: unknown) => unknown) =>
    prisma.$transaction(fn as never)) as never);
});

afterAll(() => h?.stop());

beforeEach(async () => {
  await h.pg.exec(`
    TRUNCATE "Image", "CsamQueueSetAside", "ModActivity";
    INSERT INTO "Image" (id, type, "userId", "postId", ingestion, "blockedFor", "needsReview", metadata) VALUES
      (${SONG}, 'audio', ${OWNER}, 1, 'Scanned', NULL, NULL, '{"coverImageId": ${COVER}}'),
      (${COVER}, 'image', ${OWNER}, NULL, 'Blocked', 'CSAM', NULL, '{"parentId": ${SONG}}'),
      (${PICTURE}, 'image', ${OWNER}, NULL, 'Blocked', 'CSAM', NULL, '{}'),
      (${FORGED}, 'image', ${OTHER}, NULL, 'Blocked', 'CSAM', NULL, '{"parentId": ${SONG}}'),
      (${HELD_SONG}, 'audio', ${OWNER}, 2, 'Scanned', NULL, 'csam',
        '{"coverImageId": ${HELD_COVER}, "csamHold": {"lyrics": 5}}'),
      (${HELD_COVER}, 'image', ${OWNER}, NULL, 'Blocked', 'CSAM', NULL, '{"parentId": ${HELD_SONG}}');
  `);
});

const row = async (id: number) =>
  (
    await h.pg.query<{ needsReview: string | null; marker: Record<string, number> | null }>(
      `SELECT "needsReview", metadata -> 'csamHold' AS marker FROM "Image" WHERE id = $1`,
      [id]
    )
  ).rows[0];

describe('the CSAM self-heal job, on songs of covers removed for CSAM', () => {
  it('holds the unheld song with the cover as its source, once', async () => {
    const first = await runCsamBlocklistSelfHeal();

    expect(first.songHolds).toEqual({ candidates: 1, held: 1, failed: 0, capped: false });
    expect(await row(SONG)).toEqual({ needsReview: 'csam', marker: { cover: COVER } });

    const second = await runCsamBlocklistSelfHeal();

    expect(second.songHolds).toEqual({ candidates: 0, held: 0, failed: 0, capped: false });
    expect(await row(SONG)).toEqual({ needsReview: 'csam', marker: { cover: COVER } });
  });

  it('leaves an already-held song as it was', async () => {
    await runCsamBlocklistSelfHeal();

    expect(await row(HELD_SONG)).toEqual({ needsReview: 'csam', marker: { lyrics: 5 } });
  });

  it("ignores a picture and another user's row naming the song", async () => {
    await h.pg.exec(`UPDATE "Image" SET "blockedFor" = NULL WHERE id = ${COVER}`);

    const { songHolds } = await runCsamBlocklistSelfHeal();

    expect(songHolds).toMatchObject({ candidates: 0, held: 0 });
    for (const id of [SONG, PICTURE, FORGED])
      expect(await row(id)).toEqual({ needsReview: null, marker: null });
  });

  it('leaves a song a moderator has acted on to the moderator', async () => {
    await h.pg.exec(`INSERT INTO "ModActivity" ("userId", "entityType", "entityId", activity)
      VALUES (${MOD}, 'image', ${SONG}, 'review')`);

    const { songHolds } = await runCsamBlocklistSelfHeal();

    expect(songHolds).toMatchObject({ candidates: 0, held: 0 });
    expect(await row(SONG)).toEqual({ needsReview: null, marker: null });
  });
});
