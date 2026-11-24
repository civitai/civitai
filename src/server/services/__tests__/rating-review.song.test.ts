import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { ratingDisputeEnabled } from '~/server/schema/rating-review.schema';
import { loadRatingReviewSubject } from '~/server/services/rating-review.entities';
import {
  createRatingReview,
  getRatingReviewForOwner,
} from '~/server/services/rating-review.service';

// A song is an Image row of type audio; its dispute is filed as entity type `Song` on the image id.
const OWNER = 3;
const SONG = 41;
const at = new Date('2026-11-20T00:00:00Z');

const song = (over: Record<string, unknown> = {}) => ({
  userId: OWNER,
  type: 'audio',
  ingestion: 'Scanned',
  nsfwLevel: 8,
  updatedAt: at,
  metadata: { title: 'Night drive' },
  ...over,
});

const file = (over: Partial<Parameters<typeof createRatingReview>[0]> = {}) =>
  createRatingReview({
    entityType: 'Song',
    entityId: SONG,
    suggestedLevel: 4,
    userId: OWNER,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.image.findUnique.mockResolvedValue(song());
  dbMock.dbRead.entityModeration.findUnique.mockResolvedValue(null);
  dbMock.dbRead.ratingReview.findFirst.mockResolvedValue(null);
  dbMock.dbWrite.ratingReview.create.mockImplementation(async ({ data }: { data: object }) => ({
    id: 1,
    ...data,
  }));
  redisMock.redis.incr.mockResolvedValue(1);
});

describe('a song rating dispute', () => {
  it("files the owner's dispute on their reviewed song at its current level, with no text scan behind it", async () => {
    const review = await file({ userComment: ' It is instrumental ' });

    expect(review).toMatchObject({
      entityType: 'Song',
      entityId: SONG,
      userId: OWNER,
      currentLevel: 8,
      suggestedLevel: 4,
      userComment: 'It is instrumental',
      status: 'Pending',
    });
    expect(dbMock.dbRead.image.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SONG } })
    );
  });

  it('refuses anyone but the owner', async () => {
    await expect(file({ userId: OWNER + 1 })).rejects.toThrow(
      'Only the owner can dispute this rating'
    );
    expect(dbMock.dbWrite.ratingReview.create).not.toHaveBeenCalled();
  });

  it('refuses an image that is not a song, so a plain image never becomes disputable', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue(song({ type: 'image' }));
    await expect(file()).rejects.toThrow(`No Song with id ${SONG}`);
    expect(dbMock.dbWrite.ratingReview.create).not.toHaveBeenCalled();
  });

  it('refuses a song its own scans have not reviewed yet, and a removed one', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue(song({ ingestion: 'Pending' }));
    await expect(file()).rejects.toThrow(
      "This song is still being reviewed, so its rating can't be disputed yet."
    );
    dbMock.dbRead.image.findUnique.mockResolvedValue(song({ ingestion: 'Blocked' }));
    await expect(file()).rejects.toThrow("This song was removed, so its rating can't be disputed.");
    expect(dbMock.dbWrite.ratingReview.create).not.toHaveBeenCalled();
  });

  it('tells the owner a song whose scan gave up can never be disputed, and one due a retry not yet', async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue(
      song({
        ingestion: 'Error',
        scanJobs: { retryCount: 1, error: { failureClass: 'permanent' } },
      })
    );
    await expect(file()).rejects.toThrow(
      "This song's scans could not review it, so its rating can't be disputed."
    );
    dbMock.dbRead.image.findUnique.mockResolvedValue(
      song({
        ingestion: 'Error',
        scanJobs: { retryCount: 2, lastFailure: { failureClass: 'unknown' } },
      })
    );
    await expect(file()).rejects.toThrow(
      "This song is still being reviewed, so its rating can't be disputed yet."
    );
    expect(dbMock.dbWrite.ratingReview.create).not.toHaveBeenCalled();
  });

  it('keeps one pending dispute per song', async () => {
    dbMock.dbRead.ratingReview.findFirst.mockImplementation(
      async (args: { where: { status: unknown } }) =>
        args.where.status === 'Pending' ? { id: 9 } : null
    );
    await expect(file()).rejects.toThrow('A dispute is already pending for this item');
  });

  it('names the song by its title, and by its id when it has none', async () => {
    expect(await loadRatingReviewSubject('Song', SONG)).toMatchObject({
      ownerId: OWNER,
      currentLevel: 8,
      title: 'Night drive',
    });
    dbMock.dbRead.image.findUnique.mockResolvedValue(song({ metadata: {} }));
    expect((await loadRatingReviewSubject('Song', SONG))?.title).toBe(`Song #${SONG}`);
  });

  it("offers the owner a dispute on their reviewed song's page", async () => {
    expect(
      await getRatingReviewForOwner({ entityType: 'Song', entityId: SONG, userId: OWNER })
    ).toMatchObject({ canDispute: true, canResubmit: true, currentLevel: 8, review: null });
  });
});

describe('ratingDisputeEnabled', () => {
  it('needs the music flag beside ratingDispute for a song', () => {
    expect(ratingDisputeEnabled({ ratingDispute: true, music: true }, 'Song')).toBe(true);
    expect(ratingDisputeEnabled({ ratingDispute: true, music: false }, 'Song')).toBe(false);
    expect(ratingDisputeEnabled({ ratingDispute: false, music: true }, 'Song')).toBe(false);
  });

  it('leaves every other type on its own flag alone', () => {
    expect(ratingDisputeEnabled({ ratingDispute: true, music: false }, 'Post')).toBe(true);
    expect(ratingDisputeEnabled({ articleRatingDispute: true, music: false }, 'Article')).toBe(
      true
    );
    expect(ratingDisputeEnabled({ ratingDispute: false, music: true }, 'Post')).toBe(false);
  });
});
