import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';

const mocks = vi.hoisted(() => ({
  hold: vi.fn(),
  queueSearch: vi.fn(),
  decide: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('~/server/services/text-scan/actions/csam-hold', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  withCsamHold:
    (entityType: string, apply: (args: unknown) => Promise<unknown>) => async (args: unknown) => {
      await mocks.hold(entityType, args);
      await apply(args);
    },
}));
vi.mock('~/server/services/image.service', () => ({
  queueImageSearchIndexUpdate: mocks.queueSearch,
}));
vi.mock('~/server/services/audio-scan/apply-song-scan', () => ({
  applySongLyricsVerdict: mocks.decide,
}));
vi.mock('~/server/services/audio-scan/track-lyrics', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitTrackLyricsScan: mocks.submit,
}));

await import('~/server/services/text-scan/profiles/index');
const { getTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { getModerationAdapter } = await import('~/server/services/moderation-adapters');

const w = dbMock.dbWrite;
const args = (csam: boolean) => ({
  entityId: 7,
  workflowId: 'wf-1',
  textHash: 'h',
  subject: { fields: [], declared: {} },
  outcome: { triggeredLabels: [], nsfwLevel: null, csam: { detected: csam, reason: 'r' } },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the TrackLyrics text-scan profile', () => {
  it("scans a song's lyrics as its owner's text, draft or not", async () => {
    w.trackLyrics.findMany.mockResolvedValue([
      { imageId: 7, text: 'la la', image: { userId: 3 } },
    ] as never);

    const subjects = await getTextScanProfile('TrackLyrics')!.load([7]);

    expect(subjects.get(7)).toEqual({
      userId: 3,
      declared: {},
      fields: [{ heading: 'Lyrics', text: 'la la' }],
    });
  });
});

describe('the TrackLyrics moderation adapter', () => {
  const applyTextScan = () => getModerationAdapter('TrackLyrics')?.applyTextScan;

  it('records a csam hold for a verdict, then takes a held song out of search', async () => {
    w.textScanHold.findFirst.mockResolvedValue({ id: 4 } as never);

    await applyTextScan()!(args(true) as never);

    expect(mocks.hold).toHaveBeenCalledWith('TrackLyrics', expect.anything());
    expect(mocks.queueSearch).toHaveBeenCalledWith({
      ids: [7],
      action: SearchIndexUpdateQueueAction.Delete,
    });
    expect(mocks.decide).toHaveBeenCalledWith(7);
  });

  it('lets a failed lyrics scan reach the song, to be counted', async () => {
    await getModerationAdapter('TrackLyrics')!.applyFailure!({
      entityId: 7,
      workflowId: 'wf',
      status: 'failed',
    });

    expect(mocks.decide).toHaveBeenCalledWith(7);
  });

  it('takes no XGuard verdict: lyrics are scanned by the text scan alone', () => {
    expect(getModerationAdapter('TrackLyrics')!.applyResult).toBeUndefined();
  });

  it('re-sends lyrics from the retry cron through the text scan', async () => {
    dbMock.dbRead.trackLyrics.findMany.mockResolvedValue([{ imageId: 7, text: 'la la' }] as never);
    const adapter = getModerationAdapter('TrackLyrics')!;

    const content = (await adapter.resolveContent([7])).get(7)!;
    await adapter.submit({ entityId: 7, content });

    expect(mocks.submit).toHaveBeenCalledWith({ imageId: 7, fromRetry: true });
  });

  it('leaves search alone when no hold is pending, as for text a moderator already cleared', async () => {
    w.textScanHold.findFirst.mockResolvedValue(null);

    await applyTextScan()!(args(true) as never);

    expect(mocks.queueSearch).not.toHaveBeenCalled();
  });

  it('leaves search alone for a verdict with no csam detection, and decides the song', async () => {
    await applyTextScan()!(args(false) as never);

    expect(mocks.queueSearch).not.toHaveBeenCalled();
    expect(w.textScanHold.findFirst).not.toHaveBeenCalled();
    expect(mocks.decide).toHaveBeenCalledWith(7);
  });
});
