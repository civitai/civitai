import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ImageService from '~/server/services/image.service';
import type * as SignalClient from '~/utils/signal-client';

vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  queueImageSearchIndexUpdate: vi.fn(() => Promise.resolve()),
}));
// The owner's editor is told of the new level through the signals service.
vi.mock('~/utils/signal-client', async (importOriginal) => ({
  ...(await importOriginal<typeof SignalClient>()),
  signalClient: { send: vi.fn(async () => undefined) },
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import { applyIngestionSideEffects, type ScanImage } from '../image-scan-pipeline';
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
  dbMock.dbWrite.image.findUnique.mockResolvedValue(songRow as never);
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
