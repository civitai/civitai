import { beforeEach, describe, expect, it, vi } from 'vitest';

const pipeline = vi.hoisted(() => ({
  loadImageForScan: vi.fn(),
  resolveScanOutcome: vi.fn(),
  applyIngestionSideEffects: vi.fn(),
  markImageScanError: vi.fn(),
  sendIngestionSignal: vi.fn(),
}));

vi.mock('~/server/services/image-scan-pipeline', async () => ({
  ...pipeline,
  extractFailedSteps: () => [],
}));
vi.mock('~/server/services/job-queue.service', () => ({ removeImageScanJobQueue: vi.fn() }));
const lyricsScan = vi.hoisted(() => ({ submit: vi.fn() }));
vi.mock('~/server/services/audio-scan/track-lyrics', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendTrackLyricsScan: lyricsScan.submit,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  applySongLyricsVerdict,
  applySongScanResult,
} from '~/server/services/audio-scan/apply-song-scan';
import { removeImageScanJobQueue } from '~/server/services/job-queue.service';
import type { AudioScanParse } from '~/server/services/video-audio-scan.service';
import { NsfwLevel } from '~/server/common/enums';

const song = (over: Record<string, unknown> = {}) => ({
  id: 7,
  userId: 2,
  type: 'audio',
  meta: {},
  metadata: { duration: 30 },
  nsfwLevelLocked: false,
  nsfwLevel: 0,
  ...over,
});

const scanned = (flagged: boolean): AudioScanParse => ({
  ok: true,
  flagged,
  hasAudio: true,
  result: {} as never,
});
const run = (parsed: AudioScanParse, image = song()) => {
  pipeline.loadImageForScan.mockResolvedValue(image);
  return applySongScanResult({ imageId: 7, workflowId: 'wf', parsed, steps: [] });
};
const withLyrics = (verdict?: { status: string; blocked?: boolean | null }) => {
  dbMock.dbWrite.trackLyrics.findUnique.mockResolvedValue({ imageId: 7 } as never);
  dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue(
    (verdict ? { blocked: null, ...verdict } : null) as never
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.trackLyrics.findUnique.mockResolvedValue(null);
  dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue(null);
  pipeline.resolveScanOutcome.mockResolvedValue({ ingestion: 'Scanned', blockedFor: null });
  pipeline.markImageScanError.mockResolvedValue({ retryCount: 1, userId: 2, failureClass: 'x' });
});

describe('a song the scan flagged', () => {
  it('is blocked, with the reason, through the shared writer', async () => {
    pipeline.resolveScanOutcome.mockResolvedValue({ ingestion: 'Blocked', blockedFor: 'tos' });

    await run(scanned(true));

    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf',
        fixed: { nsfwLevel: NsfwLevel.Blocked, blockedFor: 'tos', minor: true },
      })
    );
    expect(pipeline.applyIngestionSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { ingestion: 'Blocked', blockedFor: 'tos' } })
    );
  });
});

describe('a song the scan did not flag', () => {
  it('is Scanned at PG through the shared writer, whose guards decide the rest', async () => {
    const image = song({ nsfwLevelLocked: true, nsfwLevel: 4 });

    await run(scanned(false), image);

    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        image: expect.objectContaining({ nsfwLevelLocked: true }),
        fixed: { nsfwLevel: NsfwLevel.PG },
      })
    );
    expect(removeImageScanJobQueue).toHaveBeenCalledWith([7]);
    expect(pipeline.applyIngestionSideEffects).toHaveBeenCalledTimes(1);
  });

  it('is cleared as an instrumental when the scan found no audio and none was stored', async () => {
    const noAudio: AudioScanParse = {
      ok: true,
      flagged: null,
      hasAudio: false,
      result: {} as never,
    };

    await run(noAudio);

    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ fixed: { nsfwLevel: NsfwLevel.PG } })
    );
  });
});

describe('a song with lyrics', () => {
  it('stays Pending on a clean audio scan until its lyrics verdict arrives, and re-sends a lost lyrics scan', async () => {
    withLyrics();

    await run(scanned(false));

    expect(pipeline.resolveScanOutcome).not.toHaveBeenCalled();
    expect(removeImageScanJobQueue).not.toHaveBeenCalled();
    expect(lyricsScan.submit).toHaveBeenCalledWith(7);
  });

  it.each(['Failed', 'Expired', 'Canceled'])(
    'counts a %s lyrics scan as a retry, putting the song in Error for the capped retry lane',
    async (status) => {
      withLyrics({ status });

      await run(scanned(false));

      expect(pipeline.resolveScanOutcome).not.toHaveBeenCalled();
      expect(pipeline.markImageScanError).toHaveBeenCalledWith(
        expect.objectContaining({ imageId: 7, failureType: 'lyrics-scan-failed' })
      );
      expect(lyricsScan.submit).not.toHaveBeenCalled();
    }
  );

  it('counts a lyrics send that throws as a lyrics failure, not an audio error', async () => {
    withLyrics();
    lyricsScan.submit.mockRejectedValueOnce(new Error('orchestrator down'));

    await run(scanned(false));

    expect(pipeline.markImageScanError).toHaveBeenCalledTimes(1);
    expect(pipeline.markImageScanError).toHaveBeenCalledWith(
      expect.objectContaining({ failureType: 'lyrics-submit-failed' })
    );
    expect(pipeline.resolveScanOutcome).not.toHaveBeenCalled();
  });

  it('does not re-send a lyrics scan that is still in flight', async () => {
    withLyrics({ status: 'Pending' });

    await run(scanned(false));

    expect(pipeline.resolveScanOutcome).not.toHaveBeenCalled();
    expect(lyricsScan.submit).not.toHaveBeenCalled();
  });

  it('is Scanned at PG once the audio is clean and the lyrics verdict is clean', async () => {
    withLyrics({ status: 'Succeeded', blocked: false });

    await run(scanned(false));

    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ fixed: { nsfwLevel: NsfwLevel.PG } })
    );
  });

  it('is Scanned at PG whatever the lyrics verdict flagged: it is recorded, never a block', async () => {
    withLyrics({ status: 'Succeeded', blocked: true });

    await run(scanned(false));

    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ fixed: { nsfwLevel: NsfwLevel.PG } })
    );
  });
});

describe('a lyrics verdict landing', () => {
  const audioRow = (status: string) =>
    dbMock.dbWrite.imageAudioScan.findUnique.mockResolvedValue({
      status,
      workflowId: 'wf-audio',
      flagged: false,
      hasAudio: true,
      result: {},
    } as never);

  it('decides a Pending song whose audio verdict is already stored', async () => {
    withLyrics({ status: 'Succeeded', blocked: false });
    audioRow('Succeeded');
    pipeline.loadImageForScan.mockResolvedValue(song({ ingestion: 'Pending' }));

    await applySongLyricsVerdict(7);

    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-audio', fixed: { nsfwLevel: NsfwLevel.PG } })
    );
  });

  it('counts a failed lyrics scan on a song whose audio verdict is stored', async () => {
    withLyrics({ status: 'Failed' });
    audioRow('Succeeded');
    pipeline.loadImageForScan.mockResolvedValue(song({ ingestion: 'Pending' }));

    await applySongLyricsVerdict(7);

    expect(pipeline.markImageScanError).toHaveBeenCalledWith(
      expect.objectContaining({ workflowId: 'wf-audio', failureType: 'lyrics-scan-failed' })
    );
  });

  it('leaves the decision to the audio callback while the audio scan is still out', async () => {
    withLyrics({ status: 'Succeeded', blocked: false });
    audioRow('Pending');

    await applySongLyricsVerdict(7);

    expect(pipeline.resolveScanOutcome).not.toHaveBeenCalled();
  });

  it('does not decide a song already decided', async () => {
    withLyrics({ status: 'Succeeded', blocked: true });
    audioRow('Succeeded');
    pipeline.loadImageForScan.mockResolvedValue(song({ ingestion: 'Scanned' }));

    await applySongLyricsVerdict(7);

    expect(pipeline.resolveScanOutcome).not.toHaveBeenCalled();
  });

  it('leaves a stored audio verdict that found no audio to the audio lane, rather than counting it again', async () => {
    withLyrics({ status: 'Succeeded' });
    dbMock.dbWrite.imageAudioScan.findUnique.mockResolvedValue({
      status: 'Succeeded',
      workflowId: 'wf-audio',
      flagged: null,
      hasAudio: null,
      result: {},
    } as never);
    pipeline.loadImageForScan.mockResolvedValue(song({ ingestion: 'Error' }));

    await applySongLyricsVerdict(7);

    expect(pipeline.markImageScanError).not.toHaveBeenCalled();
    expect(pipeline.resolveScanOutcome).not.toHaveBeenCalled();
  });
});

describe('a song whose scan did not produce a verdict', () => {
  it('goes to Error for the cron to retry, and is never written as a pass', async () => {
    await run({ ok: false, error: 'workflow expired', failureType: 'expired' });

    expect(pipeline.resolveScanOutcome).not.toHaveBeenCalled();
    expect(pipeline.markImageScanError).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf',
        imageId: 7,
        failureType: 'expired',
        reason: 'workflow expired',
      })
    );
    expect(pipeline.sendIngestionSignal).toHaveBeenCalledWith(
      expect.objectContaining({ imageId: 7, ingestion: 'Error' })
    );
    expect(removeImageScanJobQueue).not.toHaveBeenCalled();
  });

  it('does the same when the scan found no audio in a song that has lyrics', async () => {
    withLyrics();
    const noAudio: AudioScanParse = {
      ok: true,
      flagged: null,
      hasAudio: false,
      result: {} as never,
    };

    await run(noAudio);

    expect(pipeline.resolveScanOutcome).not.toHaveBeenCalled();
    expect(pipeline.markImageScanError).toHaveBeenCalledTimes(1);
  });

  it('goes to Error when writing the verdict fails, rather than staying Pending forever', async () => {
    pipeline.resolveScanOutcome.mockRejectedValue(new Error('db down'));

    await run(scanned(false));

    expect(pipeline.markImageScanError).toHaveBeenCalledWith(
      expect.objectContaining({ failureType: 'processing-failed', reason: 'db down' })
    );
  });

  it('keeps a stored verdict when only its side effects fail', async () => {
    pipeline.applyIngestionSideEffects.mockRejectedValue(new Error('search down'));

    await expect(run(scanned(false))).resolves.not.toThrow();
    expect(pipeline.markImageScanError).not.toHaveBeenCalled();
  });
});
