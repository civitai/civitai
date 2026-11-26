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
import { getModerationAdapter } from '~/server/services/moderation-adapters';

/**
 * A song's lyrics profanity verdict (XGuard `mode: 'profanity'`): languageLevel 0, 1, 2 rate PG,
 * PG-13, R (decision L6 of the music synced-lyrics feature), null rates nothing, and the song is
 * re-rated with it.
 */

const SONG = 20;
const w = dbMock.dbWrite;
const apply = (languageLevel: number | null) =>
  getModerationAdapter('TrackLyricsLanguage')!.applyResult!({
    entityId: SONG,
    workflowId: 'wf-1',
    blocked: false,
    triggeredLabels: [],
    output: { blocked: false, triggeredLabels: [], results: [], languageLevel },
  });

beforeEach(() => {
  vi.clearAllMocks();
  w.entityModeration.updateMany.mockResolvedValue({ count: 1 } as never);
  w.image.findUnique.mockResolvedValue({
    id: SONG,
    userId: 2,
    type: 'audio',
    ingestion: 'Scanned',
    nsfwLevel: NsfwLevel.PG,
    nsfwLevelLocked: false,
    blockedFor: null,
    metadata: {},
    postId: null,
  } as never);
  w.track.findUnique.mockResolvedValue(null);
  w.image.updateMany.mockResolvedValue({ count: 1 } as never);
});

describe('a lyrics profanity verdict', () => {
  it.each([
    [0, NsfwLevel.PG],
    [1, NsfwLevel.PG13],
    [2, NsfwLevel.R],
  ])('stores languageLevel %i as level %i on its own row', async (languageLevel, level) => {
    await apply(languageLevel);

    expect(w.entityModeration.updateMany).toHaveBeenCalledWith({
      where: { entityType: 'TrackLyricsLanguage', entityId: SONG, workflowId: 'wf-1' },
      data: { nsfwLevel: level },
    });
  });

  it('raises the song it rates', async () => {
    w.entityModeration.findMany.mockResolvedValue([
      { entityType: 'TrackLyricsLanguage', nsfwLevel: NsfwLevel.R, result: null },
    ] as never);

    await apply(2);

    expect(w.image.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nsfwLevel: NsfwLevel.R, nsfwLevelLocked: false } })
    );
  });

  it('stores no level when the scoring failed: not rated is not clean', async () => {
    w.entityModeration.findMany.mockResolvedValue([
      { entityType: 'TrackLyricsLanguage', nsfwLevel: null, result: null },
    ] as never);

    await apply(null);

    expect(w.entityModeration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nsfwLevel: null } })
    );
    expect(w.image.updateMany).not.toHaveBeenCalled();
  });

  it('is resubmitted from the lyrics text by the retry cron', async () => {
    dbMock.dbRead.trackLyrics.findMany.mockResolvedValue([
      { imageId: SONG, text: 'la la' },
    ] as never);

    const content = await getModerationAdapter('TrackLyricsLanguage')!.resolveContent([SONG]);

    expect(content.get(SONG)).toBe('la la');
  });
});
