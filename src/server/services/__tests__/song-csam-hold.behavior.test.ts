import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type { Prisma } from '@prisma/client';
import type * as DbHelpers from '~/server/db/db-helpers';

/**
 * A song is held for csam review as a video is: a csam hold on its lyrics, or a csam flag on its
 * cover, flags the song's own row, and every read hides it by that flag. Released only when this
 * mechanism set the flag and no other csam reason remains. Run on PGlite through the entry points:
 * the lyrics scan's adapter, Report CSAM, the hold decision and the main app's unblock.
 */

vi.setConfig({ hookTimeout: 120_000, testTimeout: 120_000 });

// The feed's statement is captured at the query helper and run on PGlite below.
const feed = vi.hoisted(() => ({ statement: null as Prisma.Sql | null }));
const FEED_CAPTURED = new Error('feed statement captured');
vi.mock('~/server/db/db-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbHelpers>()),
  queryWithTimeout: vi.fn(async (_db: unknown, _ms: number, statement: Prisma.Sql) => {
    feed.statement = statement;
    throw FEED_CAPTURED;
  }),
}));

const { trackLyricsModerationAdapter } = await import(
  '~/server/services/track-lyrics-moderation.adapter'
);
const { decideCsamHold } = await import('~/server/services/text-scan/csam-hold-decision');
const { reportCsamImages, handleUnblockImages, getAllImages } = await import(
  '~/server/services/image.service'
);
const { getImageIdsVisibleToViewer } = await import('~/server/services/image-visibility.service');
const { resolveScanOutcome } = await import('~/server/services/image-scan-pipeline');

const OWNER = 990000010;
const STRANGER = 990000020;
const OTHER = 990000030;
const MOD = 990000040;

const SONG = 990000101;
const COVER = 990000102;
const PICTURE = 990000103;
const VIDEO = 990000104;
const THUMBNAIL = 990000105;
const FORGED = 990000106;

const SCHEMA = `
  CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
  CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
  CREATE TYPE "TextScanHoldStatus" AS ENUM ('Pending', 'Dismissed', 'Confirmed');
  CREATE TYPE "ReportReason" AS ENUM ('TOSViolation', 'NSFW', 'CSAM');
  CREATE TYPE "ReportStatus" AS ENUM ('Pending', 'Processing', 'Actioned', 'Unactioned');
  CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
  CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
  CREATE TYPE "UserEngagementType" AS ENUM ('Follow', 'Hide', 'Block');
  CREATE TABLE "User" (id int PRIMARY KEY, username text, "deletedAt" timestamp, "bannedAt" timestamp);
  CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type "UserEngagementType");
  CREATE TABLE "Image" (
    id int PRIMARY KEY, type "MediaType" NOT NULL DEFAULT 'image', "userId" int NOT NULL,
    "postId" int, "nsfwLevel" int NOT NULL DEFAULT 1, "needsReview" text, "blockedFor" text,
    ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned', "nsfwLevelLocked" boolean DEFAULT false,
    metadata jsonb NOT NULL DEFAULT '{}', "scanJobs" jsonb, minor boolean NOT NULL DEFAULT false,
    poi boolean NOT NULL DEFAULT false, "acceptableMinor" boolean NOT NULL DEFAULT false,
    "modelRestricted" boolean NOT NULL DEFAULT false, "pHash" bigint, "scannedAt" timestamp,
    "updatedAt" timestamp(3), name text, url text, width int, height int, hash text, meta jsonb,
    "hideMeta" boolean NOT NULL DEFAULT false, "createdAt" timestamp NOT NULL DEFAULT now(),
    "mimeType" text, index int
  );
  CREATE TABLE "TextScanHold" (
    id serial PRIMARY KEY, "entityType" text NOT NULL, "entityId" int NOT NULL, label text NOT NULL,
    "textHash" text NOT NULL, status "TextScanHoldStatus" NOT NULL DEFAULT 'Pending', "userId" int,
    text text NOT NULL, reason text NOT NULL, "workflowId" text, "promptId" int, "contentAt" timestamp(3),
    "createdAt" timestamp(3) NOT NULL DEFAULT now(), "updatedAt" timestamp(3) NOT NULL DEFAULT now(),
    "decidedAt" timestamp(3), "decidedById" int, "decisionNote" text, "hiddenAt" timestamp(3),
    "restoredAt" timestamp(3), meta jsonb
  );
  CREATE TABLE "CsamQueueSetAside" (
    "imageId" int PRIMARY KEY, "userId" int NOT NULL, outcome text NOT NULL, "moderatorId" int NOT NULL,
    "createdAt" timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE "Report" (id serial PRIMARY KEY, reason "ReportReason" NOT NULL, status "ReportStatus" NOT NULL);
  CREATE TABLE "ImageReport" ("imageId" int NOT NULL, "reportId" int NOT NULL);
  CREATE TABLE "ImageDeferredBlockEffect" ("imageId" int);
  CREATE TABLE "ImageTagForReview" ("imageId" int, "tagId" int);
  CREATE TABLE "TagsOnImageDetails" ("imageId" int, "tagId" int, disabled boolean);
  CREATE TABLE "ModActivity" ("userId" int, "entityType" text, "entityId" int, activity text);
  CREATE TYPE "EntityType" AS ENUM ('Image');
  CREATE DOMAIN "JobQueueType" AS text;
  CREATE TABLE "JobQueue" ("entityId" int, "entityType" "EntityType", type "JobQueueType",
    "createdAt" timestamp(3) NOT NULL DEFAULT now(), PRIMARY KEY ("entityType", "entityId", type));
  CREATE TABLE "Post" (
    id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
    availability "Availability" DEFAULT 'Public', "collectionId" int, title text, metadata jsonb,
    "modelVersionId" int, "model3dId" int
  );
  CREATE TABLE "Article" (
    id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text,
    "bannerId" int, availability "Availability" DEFAULT 'Public', "userId" int
  );
  CREATE TABLE "CollectionContributor" (
    "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
  );
  CREATE TABLE "Bounty" (id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public');
  CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
  CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
  CREATE TABLE "Collection" (id int PRIMARY KEY, "userId" int NOT NULL);
  CREATE TABLE "CollectionItem" (
    id serial PRIMARY KEY, "collectionId" int NOT NULL, "imageId" int, "addedById" int, status text NOT NULL
  );
  CREATE SCHEMA label_store;
  CREATE FUNCTION label_store.text_hash(t text) RETURNS text LANGUAGE sql AS $$ SELECT md5(t) $$;
  CREATE FUNCTION label_store.record_label(
    p_subject_type text, p_subject_id text, p_content_hash text, p_family text, p_question text,
    p_value text, p_labeller_kind text, p_source_ref text, p_labelled_at timestamptz,
    p_labeller_user_id int, p_reason text, p_reason_note text, p_snapshot jsonb, p_owner_user_id int
  ) RETURNS bigint LANGUAGE sql AS $$ SELECT NULL::bigint $$;
`;

let h: Awaited<ReturnType<typeof startPglitePrisma>>;

beforeAll(async () => {
  h = await startPglitePrisma(SCHEMA);
  const { prisma } = h;
  const w = dbMock.dbWrite;
  const r = dbMock.dbRead;
  // Outside a transaction, raw SQL runs on PGlite directly: a statement a follow-up step fails on
  // (a table this schema leaves out) then fails alone, without dropping the Prisma connection.
  const raw = pgliteRaw(h.pg);
  for (const db of [w, r]) {
    db.$queryRaw.mockImplementation(raw.queryRaw as never);
    db.$executeRaw.mockImplementation(raw.executeRaw as never);
  }
  w.$transaction.mockImplementation(((fn: (tx: unknown) => unknown) =>
    prisma.$transaction(fn as never)) as never);
  w.textScanHold.findFirst.mockImplementation(((
    ...a: Parameters<typeof prisma.textScanHold.findFirst>
  ) => prisma.textScanHold.findFirst(...a)) as never);
});

afterAll(() => h?.stop());

const q = async <T>(text: string, values: unknown[] = []) =>
  (await h.pg.query<T>(text, values)).rows;

const song = async (id = SONG) =>
  (
    await q<{ needsReview: string | null; marker: Record<string, number> | null }>(
      `SELECT "needsReview", metadata -> 'csamHold' AS marker FROM "Image" WHERE id = $1`,
      [id]
    )
  )[0];

const holds = () =>
  q<{ id: number; status: string }>(
    `SELECT id, status::text AS status FROM "TextScanHold" WHERE "entityId" = $1 ORDER BY id`,
    [SONG]
  );

beforeEach(async () => {
  vi.clearAllMocks();
  await h.pg.exec(`
    TRUNCATE "Image", "TextScanHold", "CsamQueueSetAside", "Report", "ImageReport", "Post";
    INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (1, ${OWNER}, now() - interval '1 day');
    INSERT INTO "Image" (id, type, "userId", "postId", ingestion, metadata) VALUES
      (${SONG}, 'audio', ${OWNER}, 1, 'Scanned', '{"coverImageId": ${COVER}}'),
      (${COVER}, 'image', ${OWNER}, NULL, 'Scanned', '{"parentId": ${SONG}}'),
      (${PICTURE}, 'image', ${OWNER}, NULL, 'Scanned', '{}'),
      (${VIDEO}, 'video', ${OWNER}, NULL, 'Scanned', '{"thumbnailId": ${THUMBNAIL}}'),
      (${THUMBNAIL}, 'image', ${OWNER}, NULL, 'Scanned', '{"parentId": ${VIDEO}}'),
      (${FORGED}, 'image', ${OTHER}, NULL, 'Scanned', '{"parentId": ${SONG}}');
  `);
});

const csamOutcome = { triggeredLabels: [], nsfwLevel: null, csam: { detected: true, reason: 'r' } };
const scanLyrics = (textHash = 'h1', entityId = SONG) =>
  trackLyricsModerationAdapter.applyTextScan!({
    entityId,
    workflowId: 'wf',
    textHash,
    subject: { userId: OWNER, declared: {}, fields: [{ heading: 'Lyrics', text: 'la la' }] },
    outcome: csamOutcome,
  } as never);

const decide = async (decision: 'dismiss' | 'remove') => {
  const [hold] = await q<{ id: number; textHash: string }>(
    `SELECT id, "textHash" FROM "TextScanHold" WHERE "entityId" = $1 AND status = 'Pending'`,
    [SONG]
  );
  await decideCsamHold({
    holdId: hold.id,
    textHash: hold.textHash,
    decision,
    actor: { id: MOD },
    tracker: {} as never,
  });
};

const moderator = { id: MOD, isModerator: true } as never;
const visibleTo = async (userId?: number, isModerator = false) => [
  ...(await getImageIdsVisibleToViewer({ ids: [SONG], userId, isModerator })),
];

/** The songs the music feed (`image.getInfinite`) lists for `userId`, run over the seeded rows. */
const feedSongs = async (userId?: number) => {
  feed.statement = null;
  await expect(
    getAllImages({
      limit: 20,
      period: 'AllTime',
      periodMode: 'published',
      sort: 'Newest',
      browsingLevel: 31,
      include: [],
      types: ['audio'],
      user: userId ? { id: userId, isModerator: false } : undefined,
    } as never)
  ).rejects.toBe(FEED_CAPTURED);
  const { text, values } = feed.statement!;
  return (await q<{ id: number }>(text, values)).map((row) => row.id);
};

describe('a csam hold on the lyrics', () => {
  it.each(['Pending', 'Scanned', 'Error'])(
    'flags a song whose ingestion is %s, records the hold as the source, and puts it back in the queue',
    async (ingestion) => {
      await h.pg.query(`UPDATE "Image" SET ingestion = $1 WHERE id = $2`, [ingestion, SONG]);
      await h.pg.query(
        `INSERT INTO "CsamQueueSetAside" ("imageId", "userId", outcome, "moderatorId") VALUES ($1, $2, 'Dismissed', $3)`,
        [SONG, OWNER, MOD]
      );

      await scanLyrics();

      const [hold] = await holds();
      expect(hold.status).toBe('Pending');
      expect(await song()).toEqual({ needsReview: 'csam', marker: { lyrics: hold.id } });
      expect(await q(`SELECT 1 FROM "CsamQueueSetAside" WHERE "imageId" = $1`, [SONG])).toEqual([]);
    }
  );

  it('hides the song from a stranger and a signed-out viewer on the feed and a by-id read', async () => {
    expect(await visibleTo(STRANGER)).toEqual([SONG]);
    expect(await feedSongs(STRANGER)).toEqual([SONG]);

    await scanLyrics();

    expect(await visibleTo(STRANGER)).toEqual([]);
    expect(await visibleTo()).toEqual([]);
    expect(await feedSongs(STRANGER)).toEqual([]);
    expect(await feedSongs()).toEqual([]);
    // A moderator still opens it by id, as a held video, to review it.
    expect(await visibleTo(MOD, true)).toEqual([SONG]);
    // As for a held video, these two reads hide a csam hold from its owner too.
    expect(await visibleTo(OWNER)).toEqual([]);
    expect(await feedSongs(OWNER)).toEqual([]);
  });

  it('re-flags the song when the same text is detected again, or new text replaces it', async () => {
    const lift = () => h.pg.query(`UPDATE "Image" SET "needsReview" = NULL WHERE id = $1`, [SONG]);
    await scanLyrics('h1');
    await lift();

    await scanLyrics('h1');
    expect((await song()).needsReview).toBe('csam');

    await lift();
    await scanLyrics('h2');
    expect((await song()).needsReview).toBe('csam');
    expect((await holds()).map((x) => x.status)).toEqual(['Pending']);
  });

  it('puts back the review the hold replaced when the hold is dismissed', async () => {
    await h.pg.query(`UPDATE "Image" SET "needsReview" = 'modRule' WHERE id = $1`, [SONG]);

    await scanLyrics();
    expect((await song()).needsReview).toBe('csam');
    await decide('dismiss');

    expect(await song()).toEqual({ needsReview: 'modRule', marker: null });
  });

  it('writes no hold when the flag write fails', async () => {
    await h.pg.exec(`
      CREATE FUNCTION refuse_song() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'refused'; END $$;
      CREATE TRIGGER refuse_song BEFORE UPDATE ON "Image" FOR EACH ROW
        WHEN (NEW.id = ${SONG}) EXECUTE FUNCTION refuse_song();
    `);
    try {
      await expect(scanLyrics()).rejects.toThrow();
      await h.recover();
      expect(await holds()).toEqual([]);
      expect((await song()).needsReview).toBeNull();
    } finally {
      await h.pg.exec(`DROP TRIGGER refuse_song ON "Image"; DROP FUNCTION refuse_song();`);
    }
  });

  it('writes neither a hold nor a flag for text a moderator already ruled on', async () => {
    await h.pg.query(
      `INSERT INTO "TextScanHold" ("entityType", "entityId", label, "textHash", status, text, reason)
       VALUES ('TrackLyrics', $1, 'csam', 'h1', 'Dismissed', 'la la', 'r')`,
      [SONG]
    );

    await scanLyrics('h1');

    expect((await holds()).map((x) => x.status)).toEqual(['Dismissed']);
    expect(await song()).toEqual({ needsReview: null, marker: null });
  });
});

describe('a csam flag on the cover', () => {
  it('flags the song it is the cover of, in the same report, with the cover as the source', async () => {
    await reportCsamImages({ imageIds: [COVER], user: moderator });

    expect((await song(COVER)).needsReview).toBe('csam');
    expect(await song()).toEqual({ needsReview: 'csam', marker: { cover: COVER } });
    expect(await visibleTo(STRANGER)).toEqual([]);
  });

  it("flags nothing else for a picture, a video's thumbnail, or another user's row naming the song", async () => {
    await reportCsamImages({ imageIds: [PICTURE, THUMBNAIL, FORGED], user: moderator });

    const flagged = await q<{ id: number }>(
      `SELECT id FROM "Image" WHERE "needsReview" = 'csam' ORDER BY id`
    );
    expect(flagged.map((x) => x.id)).toEqual([PICTURE, THUMBNAIL, FORGED]);
  });

  it.each([
    [
      'a replaced cover the song no longer links to',
      `UPDATE "Image" SET metadata = '{"coverImageId": ${PICTURE}}' WHERE id = ${SONG}`,
      COVER,
    ],
    ['a cover row in a post', `UPDATE "Image" SET "postId" = 1 WHERE id = ${COVER}`, COVER],
    [
      'a picture linked like a cover',
      `UPDATE "Image" SET type = 'image' WHERE id = ${SONG}`,
      COVER,
    ],
    [
      "another user's row the song links to",
      `UPDATE "Image" SET metadata = '{"coverImageId": ${FORGED}}' WHERE id = ${SONG}`,
      FORGED,
    ],
  ])('holds no song for %s', async (_label, change, reported) => {
    await h.pg.exec(change);

    await reportCsamImages({ imageIds: [reported], user: moderator });

    expect((await song()).needsReview).toBeNull();
  });

  it('adds itself to a song the lyrics already hold, and leaves a moderator-flagged song unmarked', async () => {
    await scanLyrics();
    const [hold] = await holds();
    await reportCsamImages({ imageIds: [COVER], user: moderator });
    expect(await song()).toEqual({
      needsReview: 'csam',
      marker: { lyrics: hold.id, cover: COVER },
    });

    await h.pg.query(
      `UPDATE "Image" SET "needsReview" = 'csam', metadata = metadata - 'csamHold' WHERE id = $1`,
      [SONG]
    );
    await reportCsamImages({ imageIds: [COVER], user: moderator });
    expect(await song()).toEqual({ needsReview: 'csam', marker: null });
  });
});

describe("the scan's CSAM block of the cover", () => {
  const blockForCsam = (id: number) =>
    resolveScanOutcome({
      image: { id, userId: OWNER, blockedFor: null, type: 'image' } as never,
      blocked: { reason: 'CSAM' },
      workflowId: 'wf',
    });

  it('holds the song it is the cover of, with the cover as the source', async () => {
    await h.pg.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'CSAM' WHERE id = $1`,
      [COVER]
    );

    expect(await blockForCsam(COVER)).toMatchObject({ blockedFor: 'CSAM' });

    expect(await song()).toEqual({ needsReview: 'csam', marker: { cover: COVER } });
  });

  it('holds the song when a rescan finds the cover already removed for CSAM', async () => {
    await h.pg.query(
      `UPDATE "Image" SET ingestion = 'Blocked', "blockedFor" = 'CSAM' WHERE id = $1`,
      [COVER]
    );
    installFakeCacheRedis();

    const outcome = await resolveScanOutcome({
      image: { id: COVER, userId: OWNER, blockedFor: null, type: 'image', metadata: {} } as never,
      fixed: { nsfwLevel: 1 },
      workflowId: 'wf',
    });

    expect(outcome).toMatchObject({ blockedFor: 'CSAM' });
    expect(await song()).toEqual({ needsReview: 'csam', marker: { cover: COVER } });
  });

  it("holds nothing for a block of another user's row naming the song", async () => {
    await blockForCsam(FORGED);

    expect(await song()).toEqual({ needsReview: null, marker: null });
  });
});

describe('a lyrics hold decision', () => {
  it('lifts the flag on dismissal when nothing else holds the song', async () => {
    await scanLyrics();

    await decide('dismiss');

    expect(await song()).toEqual({ needsReview: null, marker: null });
  });

  it('keeps the song held, by the cover only, while the cover is still held', async () => {
    await scanLyrics();
    await reportCsamImages({ imageIds: [COVER], user: moderator });

    await decide('dismiss');

    expect(await song()).toEqual({ needsReview: 'csam', marker: { cover: COVER } });
  });

  it('keeps the song held while a user CSAM report on it is open', async () => {
    await scanLyrics();
    await h.pg.exec(`INSERT INTO "Report" (id, reason, status) VALUES (1, 'CSAM', 'Pending');
      INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${SONG}, 1);`);

    await decide('dismiss');

    expect((await song()).needsReview).toBe('csam');
  });

  it("never lifts a moderator's Report CSAM on the song, made after the hold flagged it", async () => {
    await scanLyrics();
    await reportCsamImages({ imageIds: [SONG], user: moderator });

    await decide('dismiss');

    expect(await song()).toEqual({ needsReview: 'csam', marker: null });
  });

  it('keeps the flag on a confirmation', async () => {
    await scanLyrics();
    const before = await song();

    await decide('remove');

    expect((await holds()).map((x) => x.status)).toEqual(['Confirmed']);
    expect(await song()).toEqual(before);
  });
});

describe("the main app's unblock of a cover", () => {
  const unblock = (id: number) => {
    dbMock.dbRead.image.findMany.mockResolvedValueOnce([
      {
        id,
        userId: OWNER,
        pHash: null,
        postId: null,
        nsfwLevel: 1,
        blockedFor: null,
        needsReview: 'csam',
      },
    ] as never);
    return handleUnblockImages({ ids: [id], moderatorId: MOD } as never);
  };

  it('releases the song the cover held, and only that cover', async () => {
    await reportCsamImages({ imageIds: [COVER], user: moderator });

    await unblock(COVER);

    expect((await song(COVER)).needsReview).toBeNull();
    expect(await song()).toEqual({ needsReview: null, marker: null });
  });

  it('keeps the song held while its lyrics hold is pending, dropping only the cover', async () => {
    await scanLyrics();
    const [hold] = await holds();
    await reportCsamImages({ imageIds: [COVER], user: moderator });

    await unblock(COVER);

    expect(await song()).toEqual({ needsReview: 'csam', marker: { lyrics: hold.id } });
  });

  it('keeps the song held after a confirmed lyrics hold, through a later cover clear', async () => {
    await scanLyrics();
    await decide('remove');
    await reportCsamImages({ imageIds: [COVER], user: moderator });

    await unblock(COVER);

    expect((await song()).needsReview).toBe('csam');
  });
});

describe("the main app's unblock of the song itself", () => {
  const unblockSong = () => {
    dbMock.dbRead.image.findMany.mockResolvedValueOnce([
      {
        id: SONG,
        userId: OWNER,
        pHash: null,
        postId: null,
        nsfwLevel: 1,
        blockedFor: null,
        needsReview: 'csam',
      },
    ] as never);
    return handleUnblockImages({ ids: [SONG], moderatorId: MOD } as never);
  };

  it('refuses a song whose lyrics hold was confirmed, as a video removed for CSAM', async () => {
    await scanLyrics();
    await decide('remove');

    const { restored, kept } = await unblockSong();

    expect([restored, kept]).toEqual([[], []]);
    expect((await song()).needsReview).toBe('csam');
  });

  it('lifts a song whose lyrics hold is still pending: the moderator decides', async () => {
    await scanLyrics();

    const { restored } = await unblockSong();

    expect(restored.map((x) => x.id)).toEqual([SONG]);
    expect((await song()).needsReview).toBeNull();
  });
});
