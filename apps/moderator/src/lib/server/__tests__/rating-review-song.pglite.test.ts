import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ThumbnailCache from '../thumbnail-cache';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import {
  freshRatingReviewDb,
  ratingReviewKysely,
  rows,
  seedUser,
} from './rating-review-pglite.harness';
import { Kysely } from 'kysely';

/**
 * A song's rating dispute (entity type `Song`, entityId = the song's Image id) is ruled through the
 * moderator rating writer, so a ruling follows its rule: a locked level counts as the song's review,
 * which only its own scans may give, so a song is ruled on only once they have (`ingestion` Scanned).
 */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
// Redis, the main app's cache-bust and search endpoints: the writer's side effects past the process.
vi.mock('../cache', () => ({ bustCachedObject: vi.fn(async () => undefined) }));
vi.mock('../image-moderation-effects', () => ({
  bustPostGalleryCaches: vi.fn(async () => undefined),
}));
vi.mock('../profile-picture-cache', () => ({ bustProfilePictures: vi.fn(async () => undefined) }));
vi.mock('../thumbnail-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ThumbnailCache>()),
  invalidateThumbnails: vi.fn(async () => undefined),
}));
vi.mock('../image-models-reindex', () => ({
  queueDocumentsForImageMinorChanges: vi.fn(async () => undefined),
}));
vi.mock('$env/dynamic/private', () => ({
  env: { CIVITAI_APP_URL: 'https://com.test', CIVITAI_LINK_URL: 'https://red.test' },
}));

const service = await import('../rating-reviews.service');
const { ratingDisputesSectionFor } = await import('../tickets/rating-disputes');

let db: PGlite;
let owner: number;
let mod: number;

beforeEach(async () => {
  vi.clearAllMocks();
  db = await freshRatingReviewDb();
  await db.exec(`ALTER TABLE "Image"
    ADD COLUMN "userId" INTEGER,
    ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN "scanJobs" JSONB`);
  dbHandle.current = ratingReviewKysely(db);
  owner = await seedUser(db, 'owner');
  mod = await seedUser(db, 'mod');
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

async function seedSong(
  row: { type?: string; ingestion?: string; nsfwLevel?: number; scanJobs?: object } = {}
) {
  const [r] = await rows<{ id: number }>(
    db,
    `INSERT INTO "Image" ("url", "type", "postId", "nsfwLevel", "ingestion", "userId", "metadata", "scanJobs")
     VALUES ('song.mp3', $1, 7, $2, $3, $4, '{"title":"Night drive"}', $5) RETURNING "id"`,
    [
      row.type ?? 'audio',
      row.nsfwLevel ?? 8,
      row.ingestion ?? 'Scanned',
      owner,
      row.scanJobs ? JSON.stringify(row.scanJobs) : null,
    ]
  );
  return r.id;
}

async function fileSongReview(songId: number, suggestedLevel = 4) {
  const [r] = await rows<{ id: number }>(
    db,
    `INSERT INTO "RatingReview" ("entityType", "entityId", "userId", "currentLevel", "suggestedLevel")
     VALUES ('Song', $1, $2, 8, $3) RETURNING "id"`,
    [songId, owner, suggestedLevel]
  );
  return r.id;
}

const image = async (id: number) =>
  (
    await rows<{ nsfwLevel: number; nsfwLevelLocked: boolean }>(
      db,
      `SELECT "nsfwLevel", "nsfwLevelLocked" FROM "Image" WHERE "id" = $1`,
      [id]
    )
  )[0];

const review = async (id: number) =>
  (
    await rows<{ status: string; appliedLevel: number | null; resolvedBy: number | null }>(
      db,
      `SELECT "status"::text AS status, "appliedLevel", "resolvedBy" FROM "RatingReview" WHERE "id" = $1`,
      [id]
    )
  )[0];

describe('a song rating dispute', () => {
  it('lists with the song as its entity, its page as the path and every level to apply', async () => {
    const song = await seedSong();
    const id = await fileSongReview(song);

    const [row] = await service.hydrateRatingReviews(
      await service.ratingReviewRowQuery().where('rr.id', '=', id).execute()
    );

    expect(row).toMatchObject({
      entityType: 'Song',
      entityId: song,
      entity: { id: song, title: 'Night drive', path: `/images/${song}`, nsfwLevel: 8 },
      levelOptions: [1, 2, 4, 8, 16],
    });
  });

  it("applies the ruled level to the reviewed song and locks it, as a moderator's rating does", async () => {
    const song = await seedSong();
    const id = await fileSongReview(song);

    const res = await service.resolveRatingReview({
      reviewId: id,
      appliedLevel: 4,
      moderatorId: mod,
      songs: true,
    });

    expect(res).toMatchObject({
      entityType: 'Song',
      entityId: song,
      title: 'Night drive',
      ownerUserId: owner,
      previousLevel: 8,
      status: 'Actioned',
      entityMissing: false,
    });
    expect(await image(song)).toEqual({ nsfwLevel: 4, nsfwLevelLocked: true });
    expect(await review(id)).toEqual({ status: 'Actioned', appliedLevel: 4, resolvedBy: mod });
  });

  it("commits the song's level with the ruling, then runs the writer's cache work after commit", async () => {
    const { invalidateThumbnails } = await import('../thumbnail-cache');
    const { queueDocumentsForImageMinorChanges } = await import('../image-models-reindex');
    const song = await seedSong();
    const id = await fileSongReview(song);
    let lockedWhenBusted: boolean | undefined;
    vi.mocked(invalidateThumbnails).mockImplementationOnce(async () => {
      lockedWhenBusted = (await image(song)).nsfwLevelLocked;
    });
    vi.mocked(queueDocumentsForImageMinorChanges).mockRejectedValueOnce(new Error('search down'));

    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 4, moderatorId: mod, songs: true })
    ).resolves.toMatchObject({ status: 'Actioned' });

    // Run once the ruling committed; its failure is logged, not turned into a failed ruling.
    expect(lockedWhenBusted).toBe(true);
    expect(await review(id)).toMatchObject({ status: 'Actioned', appliedLevel: 4 });
    const activity = await rows<{ activity: string }>(
      db,
      `SELECT "activity" FROM "ModActivity" WHERE "entityType" = 'image' AND "entityId" = $1`,
      [song]
    );
    expect(activity).toEqual([{ activity: 'setNsfwLevel' }]);
  });

  it('runs every after-commit step of the ruling even when an earlier one fails', async () => {
    const { invalidateThumbnails } = await import('../thumbnail-cache');
    const { bustProfilePictures } = await import('../profile-picture-cache');
    const { queueDocumentsForImageMinorChanges } = await import('../image-models-reindex');
    const song = await seedSong();
    const id = await fileSongReview(song);
    vi.mocked(invalidateThumbnails).mockRejectedValueOnce(new Error('main app down'));

    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 4, moderatorId: mod, songs: true })
    ).resolves.toMatchObject({ status: 'Actioned' });

    expect(bustProfilePictures).toHaveBeenCalledWith({ imageIds: [song] });
    expect(queueDocumentsForImageMinorChanges).toHaveBeenCalledWith({ levelImageIds: [song] });
    const activity = await rows<{ activity: string }>(
      db,
      `SELECT "activity" FROM "ModActivity" WHERE "entityType" = 'image' AND "entityId" = $1`,
      [song]
    );
    expect(activity).toEqual([{ activity: 'setNsfwLevel' }]);
  });

  it("writes the song's level on the ruling's own transaction, not beside it", async () => {
    const song = await seedSong();
    const id = await fileSongReview(song);
    // PGlite is one session, so which pool connection ran each statement is what tells them apart.
    let connection = 0;
    const ran: { connection: number; text: string }[] = [];
    const tracing = new Proxy(db, {
      get(target, key) {
        if (key === 'query')
          return async (text: string, params?: unknown[]) => {
            ran.push({ connection, text: text.trim().toLowerCase() });
            return target.query(text, params);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    dbHandle.current = new Kysely({
      dialect: pgliteDialect(tracing, { onQuery: (c) => (connection = c) }),
    });

    await service.resolveRatingReview({
      reviewId: id,
      appliedLevel: 4,
      moderatorId: mod,
      songs: true,
    });

    dbHandle.current = ratingReviewKysely(db);
    const begin = ran.find((r) => r.text === 'begin');
    const write = ran.find((r) => r.text.startsWith('update "image"'));
    expect(write?.connection).toBe(begin?.connection);
    expect(await image(song)).toEqual({ nsfwLevel: 4, nsfwLevelLocked: true });
  });

  it('refuses a ruling on a song its scans are still reviewing or will retry, and changes nothing', async () => {
    const states = [
      { ingestion: 'Pending' },
      { ingestion: 'Rescan', scanJobs: { retryCount: 8 } },
      { ingestion: 'Error', scanJobs: { retryCount: 2, error: { failureClass: 'unknown' } } },
      { ingestion: 'Error', scanJobs: { retryCount: 29, error: { failureClass: 'transient' } } },
      // Stamped unknown, but its reason reads transient now: the cron retries it under 30.
      {
        ingestion: 'Error',
        scanJobs: {
          retryCount: 12,
          error: { failureClass: 'unknown', reason: 'Failed to create container' },
        },
      },
    ];
    for (const state of states) {
      const song = await seedSong(state);
      const id = await fileSongReview(song);

      await expect(
        service.resolveRatingReview({
          reviewId: id,
          appliedLevel: 4,
          moderatorId: mod,
          songs: true,
        })
      ).rejects.toThrow(
        "This song's own scans have not reviewed it yet; they are running or will be retried. Rule on its dispute once they have."
      );

      expect(await image(song)).toEqual({ nsfwLevel: 8, nsfwLevelLocked: false });
      expect(await review(id)).toEqual({ status: 'Pending', appliedLevel: null, resolvedBy: null });
    }
  });

  it('refuses a ruling when a rescan returns the song to Pending between the read and the write', async () => {
    const song = await seedSong();
    const id = await fileSongReview(song);
    // Another writer commits between the ruling's read and its Image UPDATE: the read saw Scanned.
    let raced = false;
    const racing = new Proxy(db, {
      get(target, key) {
        if (key === 'query')
          return async (text: string, params?: unknown[]) => {
            if (!raced && /^update "Image"/i.test(text.trim())) {
              raced = true;
              await target.query(`UPDATE "Image" SET "ingestion" = 'Pending' WHERE id = $1`, [
                song,
              ]);
            }
            return target.query(text, params);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    dbHandle.current = new Kysely({ dialect: pgliteDialect(racing) });

    await expect(
      service.resolveRatingReview({ reviewId: id, appliedLevel: 4, moderatorId: mod, songs: true })
    ).rejects.toThrow('This song changed while it was being rated. Reload.');

    dbHandle.current = ratingReviewKysely(db);
    expect(raced).toBe(true);
    expect(await image(song)).toMatchObject({ nsfwLevel: 8, nsfwLevelLocked: false });
    expect(await review(id)).toEqual({ status: 'Pending', appliedLevel: null, resolvedBy: null });
  });

  it('closes the dispute as gone, with nothing applied, on a removed song, a lost file or a scan that gave up', async () => {
    const states = [
      { ingestion: 'Blocked' },
      { ingestion: 'NotFound' },
      // Past the main app's retry ceilings (image-scan-failure.ts) the ingest cron never re-sends it.
      { ingestion: 'Error', scanJobs: { retryCount: 9 } },
      { ingestion: 'Error', scanJobs: { retryCount: 1, error: { failureClass: 'permanent' } } },
      {
        ingestion: 'Error',
        scanJobs: { retryCount: 30, lastFailure: { failureClass: 'transient' } },
      },
      { ingestion: 'Rescan', scanJobs: { retryCount: 9 } },
      // No class stamped, and a reason that reads permanent: the cron gave up.
      { ingestion: 'Error', scanJobs: { retryCount: 2, error: { reason: 'could not decode' } } },
    ];
    for (const state of states) {
      const song = await seedSong(state);
      const id = await fileSongReview(song);

      await expect(
        service.resolveRatingReview({
          reviewId: id,
          appliedLevel: 4,
          moderatorId: mod,
          songs: true,
        })
      ).resolves.toMatchObject({ entityMissing: true, status: 'Unactioned' });

      expect(await image(song)).toEqual({ nsfwLevel: 8, nsfwLevelLocked: false });
      expect(await review(id)).toEqual({
        status: 'Unactioned',
        appliedLevel: null,
        resolvedBy: mod,
      });
    }
  });

  it('closes the dispute with nothing applied when the song is gone, or the image is not a song', async () => {
    const gone = await fileSongReview(990000999);
    const picture = await seedSong({ type: 'image' });
    const onPicture = await fileSongReview(picture);

    for (const id of [gone, onPicture])
      await expect(
        service.resolveRatingReview({
          reviewId: id,
          appliedLevel: 4,
          moderatorId: mod,
          songs: true,
        })
      ).resolves.toMatchObject({ entityMissing: true, status: 'Unactioned' });

    expect(await image(picture)).toEqual({ nsfwLevel: 8, nsfwLevelLocked: false });
  });

  it('counts no song dispute in the /ratings badge', async () => {
    await fileSongReview(await seedSong());
    await rows(
      db,
      `INSERT INTO "RatingReview" ("entityType", "entityId", "userId", "currentLevel", "suggestedLevel")
       VALUES ('Post', 1, $1, 4, 2)`,
      [owner]
    );

    expect(await service.getRatingReviewCounts()).toEqual({
      Pending: 1,
      Actioned: 0,
      Unactioned: 0,
    });
  });

  it("leaves song disputes out of a ticket's rating disputes: they are decided on the Audio review page", async () => {
    await fileSongReview(await seedSong());
    const [post] = await rows<{ id: number }>(
      db,
      `INSERT INTO "RatingReview" ("entityType", "entityId", "userId", "currentLevel", "suggestedLevel")
       VALUES ('Post', 1, $1, 4, 2) RETURNING "id"`,
      [owner]
    );

    const section = await ratingDisputesSectionFor({ userId: owner });

    expect(section.disputes.map((d) => d.id)).toEqual([post.id]);
  });
});
