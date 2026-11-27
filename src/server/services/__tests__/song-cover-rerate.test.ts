import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { imagesMetricsSearchIndex } from '~/server/search-index';
import { signalClient } from '~/utils/signal-client';
import { applyIngestionSideEffects, rerateSong, type ScanImage } from '../image-scan-pipeline';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * A song's own cover counts toward the song's level (docs/features/music.md "A song's rating"), so
 * the cover's scan verdict re-rates the song it is linked to.
 */

const OWNER = 2;
const SONG = 20;
const COVER = 120;

const coverRow = (over: Partial<ScanImage> = {}) =>
  ({
    id: COVER,
    userId: OWNER,
    type: 'image',
    metadata: { parentId: SONG },
    postId: null,
    nsfwLevel: NsfwLevel.R,
    ingestion: ImageIngestionStatus.Scanned,
    blockedFor: null,
    ...over,
  } as unknown as ScanImage);

const songRow = {
  id: SONG,
  userId: OWNER,
  type: 'audio',
  ingestion: ImageIngestionStatus.Scanned,
  nsfwLevel: NsfwLevel.PG,
  nsfwLevelLocked: false,
  blockedFor: null,
  metadata: {},
  postId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.track.findUnique.mockImplementation((async ({ where }: { where: object }) =>
    'coverImageId' in where
      ? { imageId: SONG }
      : { coverImage: { ...coverRow(), postId: null } }) as never);
  // What follows a rating is the scan side effects' own subject: the song's later read finds
  // nothing, so none run here.
  dbMock.dbWrite.image.findUnique.mockReset().mockResolvedValueOnce(songRow as never);
  dbMock.dbWrite.entityModeration.findMany.mockResolvedValue([]);
  dbMock.dbWrite.image.updateMany.mockResolvedValue({ count: 1 } as never);
});

describe("a song's own cover, once scanned", () => {
  it('raises the song to its rating', async () => {
    await applyIngestionSideEffects({
      image: coverRow(),
      outcome: { ingestion: ImageIngestionStatus.Scanned, blockedFor: null, reviewKey: null },
    });

    expect(dbMock.dbWrite.image.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: SONG, nsfwLevel: NsfwLevel.PG }),
        data: { nsfwLevel: NsfwLevel.R, nsfwLevelLocked: false },
      })
    );
  });

  it('leaves an image in a post alone: it is no song cover', async () => {
    await applyIngestionSideEffects({
      image: coverRow({ postId: 5 }),
      outcome: { ingestion: ImageIngestionStatus.Scanned, blockedFor: null, reviewKey: null },
    });

    expect(dbMock.dbWrite.track.findUnique).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.updateMany).not.toHaveBeenCalled();
  });
});

describe('rerateSong, once it has written a new level', () => {
  it("tells the owner's editor the new level and queues the song's search update", async () => {
    const send = vi.spyOn(signalClient, 'send').mockResolvedValue(undefined as never);
    const searchUpdate = vi
      .spyOn(imagesMetricsSearchIndex, 'queueUpdate')
      .mockResolvedValue(undefined as never);
    // The read rateSong guards with, then the read its effects run on.
    dbMock.dbWrite.image.findUnique
      .mockReset()
      .mockResolvedValueOnce(songRow as never)
      .mockResolvedValue({ ...songRow, nsfwLevel: NsfwLevel.R, needsReview: null } as never);

    await rerateSong(SONG);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OWNER,
        data: expect.objectContaining({
          imageId: SONG,
          ingestion: ImageIngestionStatus.Scanned,
          nsfwLevel: NsfwLevel.R,
        }),
      })
    );
    expect(searchUpdate).toHaveBeenCalledWith([
      { id: SONG, action: SearchIndexUpdateQueueAction.Update },
    ]);
  });
});
