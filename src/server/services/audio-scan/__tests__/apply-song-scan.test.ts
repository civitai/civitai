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

import { applySongScanResult } from '~/server/services/audio-scan/apply-song-scan';
import { removeImageScanJobQueue } from '~/server/services/job-queue.service';
import type { AudioScanParse } from '~/server/services/video-audio-scan.service';
import { NsfwLevel } from '~/server/common/enums';

const word = (text: string, startTime: number) => ({ text, startTime, endTime: startTime + 0.4 });
const transcription = (words: ReturnType<typeof word>[]) => ({
  $type: 'transcription',
  output: { text: '', timeStamps: words },
});

const song = (over: Record<string, unknown> = {}) => ({
  id: 7,
  userId: 2,
  type: 'audio',
  meta: {},
  metadata: { duration: 30, lyrics: [{ t: null, text: 'la la love' }] },
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
const run = (parsed: AudioScanParse, steps: unknown[] = [], image = song()) => {
  pipeline.loadImageForScan.mockResolvedValue(image);
  return applySongScanResult({ imageId: 7, workflowId: 'wf', parsed, steps });
};

beforeEach(() => {
  vi.clearAllMocks();
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

  it('is not given synced lyrics', async () => {
    await run(scanned(true), [transcription([word('la', 1), word('love', 2)])]);

    expect(pipeline.resolveScanOutcome.mock.calls[0][0].fixed.metadata).toBeUndefined();
  });
});

describe('a song the scan did not flag', () => {
  it('is Scanned at PG through the shared writer, whose guards decide the rest', async () => {
    const image = song({ nsfwLevelLocked: true, nsfwLevel: 4 });

    await run(scanned(false), [], image);

    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        image: expect.objectContaining({ nsfwLevelLocked: true }),
        fixed: { nsfwLevel: NsfwLevel.PG },
      })
    );
    expect(removeImageScanJobQueue).toHaveBeenCalledWith([7]);
    expect(pipeline.applyIngestionSideEffects).toHaveBeenCalledTimes(1);
  });

  it('gets the times of its lyrics from the transcription, before the writer reads its metadata', async () => {
    await run(scanned(false), [
      transcription([word(' la', 4), word(' la', 4.5), word(' love', 5)]),
    ]);

    const call = pipeline.resolveScanOutcome.mock.calls[0][0];
    expect(call.fixed.metadata).toEqual({
      duration: 30,
      lyrics: [{ t: 4, text: 'la la love' }],
    });
    expect(call.image.metadata).toEqual(call.fixed.metadata);
  });

  it.each([
    [
      'empty timestamps',
      { $type: 'transcription', output: { text: 'la la love', timeStamps: [] } },
    ],
    [
      'a failed transcription',
      { $type: 'transcription', status: 'failed', output: { timeStamps: [word('la', 1)] } },
    ],
  ])('is still Scanned at PG with unsynced lyrics after %s', async (_, step) => {
    const image = song({ metadata: { duration: 30, lyrics: [{ t: 99, text: 'la la love' }] } });

    await run(scanned(false), [step], image);

    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        fixed: {
          nsfwLevel: NsfwLevel.PG,
          metadata: { duration: 30, lyrics: [{ t: null, text: 'la la love' }] },
        },
      })
    );
  });

  it('gets lines built from the transcription when it has no stored lyrics', async () => {
    const image = song({ metadata: { duration: 30 } });

    await run(scanned(false), [transcription([word(' hello', 2), word(' there', 2.5)])], image);

    expect(pipeline.resolveScanOutcome.mock.calls[0][0].fixed.metadata).toEqual({
      duration: 30,
      lyrics: [{ t: 2, text: 'hello there' }],
    });
  });

  it('keeps its lyrics as they are when nothing could be transcribed', async () => {
    await run(scanned(false), []);

    expect(pipeline.resolveScanOutcome.mock.calls[0][0].fixed.metadata).toBeUndefined();
  });

  it('never keeps a time the client sent: with nothing transcribed the lines are stored unsynced', async () => {
    const image = song({ metadata: { duration: 30, lyrics: [{ t: 99, text: 'la la love' }] } });

    await run(scanned(false), [], image);

    expect(pipeline.resolveScanOutcome.mock.calls[0][0].fixed.metadata).toEqual({
      duration: 30,
      lyrics: [{ t: null, text: 'la la love' }],
    });
  });

  it('is cleared as an instrumental when the scan found no audio and none was stored', async () => {
    const noAudio: AudioScanParse = {
      ok: true,
      flagged: null,
      hasAudio: false,
      result: {} as never,
    };

    await run(noAudio, [], song({ metadata: { duration: 30 } }));

    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ fixed: { nsfwLevel: NsfwLevel.PG } })
    );
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
