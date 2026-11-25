import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteKysely } from '~/__tests__/pglite-kysely';
import type * as KyselyDb from '~/server/db/kyselyDb';
import { notifications } from '~/server/notifications/client';

/**
 * The main app's ToS removals of a song and of its cover (Music T10 item 2, docs/features/music.md
 * "Moderating songs"). "Remove cover" removes only the song's own cover, with its own violation type,
 * and leaves the song public with the placeholder; a held cover, an image that is not the song's own
 * cover, and a song without one are refused with nothing changed. Each removal's owner notice names
 * the song or its cover, linking to the song.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock('~/server/db/kyselyDb', async (importOriginal) => ({
  ...(await importOriginal<typeof KyselyDb>()),
  kyselyRead: pgliteKysely(() => holder.db),
  kyselyWrite: pgliteKysely(() => holder.db),
}));
vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: { insert: vi.fn(async () => undefined), $query: vi.fn(async () => []) },
}));
// The notifications app is the process boundary; the shared stub answers it here.
const createNotification = vi.mocked(notifications.createNotification);

const OWNER = 7;
const SONG = 20;
const COVER = 120;
const SONG_UNDER_REVIEW = 21;
const COVER_UNDER_REVIEW = 121;
const SONG_HELD_OWNER = 22;
const COVER_HELD_OWNER = 122;
const SONG_CSAM_HASH = 23;
const COVER_CSAM_HASH = 123;
const SONG_OTHERS_COVER = 24;
const OTHERS_IMAGE = 124;
const SONG_POSTED_COVER = 25;
const POSTED_IMAGE = 125;
const SONG_NO_COVER = 26;
const SONG_REMOVED_COVER = 27;
const REMOVED_COVER = 127;
const SONG_AUDIO_COVER = 28;
const AUDIO_AS_COVER = 128;
const HELD_OWNER = 8;
const PICTURE = 30;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, type text NOT NULL DEFAULT 'image',
      url text, ingestion text NOT NULL DEFAULT 'Scanned', "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 1, "needsReview" text, "pHash" bigint,
      "updatedAt" timestamp(3), metadata jsonb
    );
    CREATE TABLE "Track" ("imageId" int PRIMARY KEY, "coverImageId" int UNIQUE);
    CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
    CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'CSAM');
    CREATE TABLE "Report" (
      id int PRIMARY KEY, "userId" int NOT NULL, reason "ReportReason" NOT NULL,
      status "ReportStatus" NOT NULL, "statusSetAt" timestamp(3), "statusSetBy" int,
      "alsoReportedBy" int[] NOT NULL DEFAULT '{}', details jsonb,
      "previouslyReviewedCount" int NOT NULL DEFAULT 0
    );
    CREATE TABLE "ImageReport" ("imageId" int, "reportId" int);
    CREATE TABLE "User" (id int PRIMARY KEY, "bannedAt" timestamp(3));
    CREATE TABLE "CsamQueueSetAside" ("imageId" int PRIMARY KEY, outcome text NOT NULL);
    CREATE TABLE "ImageDeferredBlockEffect" (
      "imageId" int PRIMARY KEY, "violationType" text, "notifyOwner" boolean NOT NULL DEFAULT true,
      "reportReason" text, "reportIds" int[] NOT NULL DEFAULT '{}', "blockedBy" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    -- What the held predicates read.
    CREATE TABLE "CsamReport" ("userId" int, details jsonb, images jsonb, "reportSentAt" timestamp);
    CREATE TABLE "EvidenceHeldUser" ("userId" int);
    CREATE TABLE "BlockedImage" (hash bigint, reason text);
    CREATE TABLE "ScanLabelItem" (id int, "imageId" int, "voidReason" text);
    CREATE TABLE "ScanLabelFlag" ("itemId" int, snapshot jsonb);
    CREATE TABLE "ScanLabelVote" ("itemId" int, reason text);
    CREATE TABLE "ImageCdnModeratorDelete" (url text, "imageId" int, "csamReview" boolean, "userId" int);
    CREATE TABLE "EvidenceHoldImage" ("imageId" int);
  `);
});

const ROWS = `
  TRUNCATE "Image", "Track", "Report", "ImageReport", "CsamReport", "BlockedImage", "ImageDeferredBlockEffect";
  INSERT INTO "Image" (id, "userId", "postId", type, url, "needsReview", "pHash", ingestion, "blockedFor", "nsfwLevel", metadata) VALUES
    (${SONG}, ${OWNER}, 5, 'audio', 'song-a', NULL, NULL, 'Scanned', NULL, 1, '{"title": "Night drive"}'),
    (${COVER}, ${OWNER}, NULL, 'image', 'cover-a', NULL, 501, 'Scanned', NULL, 1, NULL),
    (${SONG_UNDER_REVIEW}, ${OWNER}, 5, 'audio', 'song-b', NULL, NULL, 'Scanned', NULL, 1, NULL),
    (${COVER_UNDER_REVIEW}, ${OWNER}, NULL, 'image', 'cover-b', 'csam', 502, 'Scanned', NULL, 1, NULL),
    (${SONG_HELD_OWNER}, ${HELD_OWNER}, 6, 'audio', 'song-c', NULL, NULL, 'Scanned', NULL, 1, NULL),
    (${COVER_HELD_OWNER}, ${HELD_OWNER}, NULL, 'image', 'cover-c', NULL, 503, 'Scanned', NULL, 1, NULL),
    (${SONG_CSAM_HASH}, ${OWNER}, 5, 'audio', 'song-d', NULL, NULL, 'Scanned', NULL, 1, NULL),
    (${COVER_CSAM_HASH}, ${OWNER}, NULL, 'image', 'cover-d', NULL, 504, 'Scanned', NULL, 1, NULL),
    (${SONG_OTHERS_COVER}, ${OWNER}, 5, 'audio', 'song-e', NULL, NULL, 'Scanned', NULL, 1, NULL),
    (${OTHERS_IMAGE}, 99, NULL, 'image', 'other', NULL, 505, 'Scanned', NULL, 1, NULL),
    (${SONG_POSTED_COVER}, ${OWNER}, 5, 'audio', 'song-f', NULL, NULL, 'Scanned', NULL, 1, NULL),
    (${POSTED_IMAGE}, ${OWNER}, 5, 'image', 'posted', NULL, 506, 'Scanned', NULL, 1, NULL),
    (${SONG_NO_COVER}, ${OWNER}, 5, 'audio', 'song-g', NULL, NULL, 'Scanned', NULL, 1, NULL),
    (${SONG_REMOVED_COVER}, ${OWNER}, 5, 'audio', 'song-h', NULL, NULL, 'Scanned', NULL, 1, NULL),
    (${REMOVED_COVER}, ${OWNER}, NULL, 'image', 'removed', NULL, 507, 'Blocked', 'moderated', 32, NULL),
    (${PICTURE}, ${OWNER}, 9, 'image', 'picture', NULL, 508, 'Scanned', NULL, 1, NULL),
    (${SONG_AUDIO_COVER}, ${OWNER}, 5, 'audio', 'song-i', NULL, NULL, 'Scanned', NULL, 1, NULL),
    (${AUDIO_AS_COVER}, ${OWNER}, NULL, 'audio', 'song-j', NULL, NULL, 'Scanned', NULL, 1, NULL);
  INSERT INTO "Track" ("imageId", "coverImageId") VALUES
    (${SONG}, ${COVER}), (${SONG_UNDER_REVIEW}, ${COVER_UNDER_REVIEW}),
    (${SONG_HELD_OWNER}, ${COVER_HELD_OWNER}), (${SONG_CSAM_HASH}, ${COVER_CSAM_HASH}),
    (${SONG_OTHERS_COVER}, ${OTHERS_IMAGE}), (${SONG_POSTED_COVER}, ${POSTED_IMAGE}),
    (${SONG_NO_COVER}, NULL), (${SONG_REMOVED_COVER}, ${REMOVED_COVER}),
    (${SONG_AUDIO_COVER}, ${AUDIO_AS_COVER});
  INSERT INTO "CsamReport" ("userId", details, images) VALUES (${HELD_OWNER}, '{}', '[]');
  INSERT INTO "BlockedImage" (hash, reason) VALUES (504, 'CSAM');
`;

const run = async (flat: { text: string; values: unknown[] }) =>
  holder.db.query(flat.text, flat.values as unknown[]);

beforeEach(async () => {
  vi.clearAllMocks();
  createNotification.mockResolvedValue(undefined as never);
  await holder.db.exec(ROWS);
  dbMock.dbWrite.user.findMany.mockResolvedValue([] as never);
  dbMock.dbWrite.$queryRaw.mockImplementation((async (s: TemplateStringsArray, ...v: unknown[]) => {
    const flat = Prisma.sql(s, ...(v as never[]));
    if (!/"blockedFor" = CASE|"Report"|"Image" WHERE id = ANY/.test(flat.text)) return [];
    return (await run(flat)).rows;
  }) as never);
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    s: TemplateStringsArray,
    ...v: unknown[]
  ) => {
    const flat = Prisma.sql(s, ...(v as never[]));
    if (!/"blockedFor" = CASE|"ImageDeferredBlockEffect"/.test(flat.text)) return 0;
    return (await run(flat)).affectedRows ?? 0;
  }) as never);
  // The handler's own read of the image it removes.
  dbMock.dbRead.image.findFirst.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => {
    const { rows } = await holder.db.query(
      `SELECT "nsfwLevel", "userId", "postId", type, "pHash", NULL AS post FROM "Image" WHERE id = $1`,
      [where.id]
    );
    return rows[0] ?? null;
  }) as never);
});

const { removeSongCoverHandler, setTosViolationHandler } = await import(
  '~/server/controllers/image.controller'
);
const { getSongCoverForRemoval } = await import('~/server/services/song-cover-removal.service');

const trackImages = vi.fn();
const ctx = {
  // An admin confirms re-removals without a grant row, so no removal here is held for a second opinion.
  user: { id: 2, isModerator: true, roles: ['moderator:admin'] },
  ip: '127.0.0.1',
  track: { images: trackImages },
} as never;

const imageRows = async () =>
  (
    await holder.db.query<{ id: number; ingestion: string; nsfwLevel: number }>(
      `SELECT id, ingestion, "nsfwLevel" FROM "Image" ORDER BY id`
    )
  ).rows;
const imageRow = async (id: number) => (await imageRows()).find((r) => r.id === id);
const notices = () =>
  createNotification.mock.calls.map(
    ([n]) => (n as { userId: number; details: Record<string, unknown> }) ?? null
  );

describe('Remove cover', () => {
  it("removes only the song's own cover, with its violation type, and tells the owner", async () => {
    await removeSongCoverHandler({
      input: { id: SONG, violationType: 'graphicViolence', violationDetails: 'gore' },
      ctx,
    } as never);

    expect(await imageRow(COVER)).toMatchObject({ ingestion: 'Blocked', nsfwLevel: 32 });
    expect(await imageRow(SONG)).toMatchObject({ ingestion: 'Scanned', nsfwLevel: 1 });
    // The removal is recorded on the cover, with the cover's own violation type.
    expect(trackImages).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'DeleteTOS',
        imageId: COVER,
        violationType: 'graphicViolence',
      }),
    ]);
    expect(notices()).toEqual([
      expect.objectContaining({
        userId: OWNER,
        type: 'tos-violation',
        details: expect.objectContaining({
          entity: 'song cover',
          modelName: 'Night drive',
          url: `/images/${SONG}`,
        }),
      }),
    ]);
    // The song no longer has a cover to remove.
    expect(
      await getSongCoverForRemoval(
        pgliteKysely(() => holder.db),
        SONG
      )
    ).toBeNull();
  });

  it.each([
    ['under CSAM review', SONG_UNDER_REVIEW, 'This cover is held for CSAM review'],
    ['whose owner is held', SONG_HELD_OWNER, 'This cover is held for CSAM review'],
    ['on the CSAM blocklist', SONG_CSAM_HASH, 'This cover is held for CSAM review'],
    ["that is another user's image", SONG_OTHERS_COVER, 'This song has no cover to remove.'],
    ['that is a posted image', SONG_POSTED_COVER, 'This song has no cover to remove.'],
    ['when the song has none', SONG_NO_COVER, 'This song has no cover to remove.'],
    ['when it is already removed', SONG_REMOVED_COVER, 'This song has no cover to remove.'],
    ['on an image that is not a song', PICTURE, 'This song has no cover to remove.'],
    ['that is not a picture', SONG_AUDIO_COVER, 'This song has no cover to remove.'],
  ])('is refused for a cover %s, and changes nothing', async (_, songId, message) => {
    const before = await imageRows();
    await expect(
      removeSongCoverHandler({ input: { id: songId }, ctx } as never)
    ).rejects.toMatchObject({ message: expect.stringContaining(message) });
    expect(await imageRows()).toEqual(before);
    expect(createNotification).not.toHaveBeenCalled();
    expect(trackImages).not.toHaveBeenCalled();
  });
});

describe('Remove as ToS violation', () => {
  it('names a removed song as the song', async () => {
    await setTosViolationHandler({ input: { id: SONG }, ctx } as never);
    expect(await imageRow(SONG)).toMatchObject({ ingestion: 'Blocked' });
    expect(notices()[0]?.details).toMatchObject({
      entity: 'song',
      modelName: 'Night drive',
      url: `/images/${SONG}`,
    });
  });

  it('keeps the image wording for an ordinary image', async () => {
    await setTosViolationHandler({ input: { id: PICTURE }, ctx } as never);
    expect(notices()[0]?.details).toMatchObject({
      entity: 'image',
      modelName: 'post #9',
      url: `/images/${PICTURE}`,
    });
  });
});
