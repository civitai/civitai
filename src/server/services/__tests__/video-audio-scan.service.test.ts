import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLyricsSubmit } = vi.hoisted(() => ({ mockLyricsSubmit: vi.fn() }));
vi.mock('~/server/services/audio-scan/track-lyrics', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendTrackLyricsScan: mockLyricsSubmit,
}));

const { mockGetWorkflow, mockSubmit, mockIsFlipt } = vi.hoisted(() => ({
  mockGetWorkflow: vi.fn(),
  mockSubmit: vi.fn(),
  mockIsFlipt: vi.fn(),
}));

vi.mock('@civitai/orchestration-client', async () => ({
  ...(await import('../orchestrator/__tests__/civitai-client.stub')).civitaiClientStub(),
  getWorkflow: mockGetWorkflow,
  submitWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflowWithRetry: mockSubmit,
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { VIDEO_AUDIO_SCAN: 'video-audio-scan' },
  isFlipt: mockIsFlipt,
}));
vi.mock('~/env/client', () => ({ env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' } }));

import { Prisma } from '@prisma/client';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  parseAudioScanSteps,
  processAudioScanCallback,
  submitSongScan,
  submitVideoAudioScan,
} from '~/server/services/video-audio-scan.service';
import { createImageIngestionRequest } from '~/server/services/orchestrator/orchestrator.service';

const scanned = (sexualizedMinors: boolean) => ({
  lyrics: 'la la',
  sexualizedMinors,
  blocked: sexualizedMinors,
  score: 0.5,
  model: 'm',
  policyHash: 'h',
  hasAudio: true,
  skippedReason: null,
});
const noAudio = {
  lyrics: '',
  sexualizedMinors: false,
  blocked: false,
  score: null,
  model: null,
  policyHash: null,
  hasAudio: false,
  skippedReason: 'noAudioTrack',
};
const step = (output: unknown) => ({ $type: 'audioModeration', name: 'audio', output });

describe('parseAudioScanSteps', () => {
  it('reads the flag from a scanned track', () => {
    expect(parseAudioScanSteps([step(scanned(true))])).toMatchObject({ ok: true, flagged: true });
    expect(parseAudioScanSteps([step(scanned(false))])).toMatchObject({ ok: true, flagged: false });
  });

  it('accepts a scanned track that omits the optional fields', () => {
    const { hasAudio: _h, skippedReason: _s, ...bare } = scanned(true);
    expect(parseAudioScanSteps([step(bare)])).toMatchObject({ ok: true, flagged: true });
  });

  it('records no audio as unknown, not clean', () => {
    expect(parseAudioScanSteps([step(noAudio)])).toMatchObject({
      ok: true,
      flagged: null,
      hasAudio: false,
    });
  });

  it('rejects a shape it does not know rather than reading it as a pass', () => {
    expect(parseAudioScanSteps([step({ ...scanned(false), newField: 1 })]).ok).toBe(false);
    expect(parseAudioScanSteps([step({ ...scanned(false), sexualizedMinors: 'no' })]).ok).toBe(
      false
    );
    expect(parseAudioScanSteps([step({ ...scanned(false), blocked: true })]).ok).toBe(false);
    expect(parseAudioScanSteps([step({ ...noAudio, blocked: true })]).ok).toBe(false);
    expect(parseAudioScanSteps([{ $type: 'audioModeration' }]).ok).toBe(false);
  });
});

describe('processAudioScanCallback', () => {
  beforeEach(() => {
    mockGetWorkflow.mockReset();
    dbMock.dbWrite.imageAudioScan.findFirst.mockReset().mockResolvedValue(null);
    dbMock.dbWrite.imageAudioScan.updateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it('drops an unknown workflow id without calling the orchestrator', async () => {
    const result = await processAudioScanCallback('wf-someone-elses');

    expect(result).toEqual({ stored: false, reason: 'unknown-workflow' });
    expect(mockGetWorkflow).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.imageAudioScan.updateMany).not.toHaveBeenCalled();
  });

  it('stores the verdict read back from the orchestrator', async () => {
    dbMock.dbWrite.imageAudioScan.findFirst.mockResolvedValue({ imageId: 7 });
    mockGetWorkflow.mockResolvedValue({
      data: { status: 'succeeded', metadata: { imageId: 7 }, steps: [step(scanned(true))] },
    });

    await processAudioScanCallback('wf-1');

    expect(dbMock.dbWrite.imageAudioScan.updateMany).toHaveBeenCalledWith({
      where: { workflowId: 'wf-1', status: 'Pending' },
      data: expect.objectContaining({
        status: 'Succeeded',
        flagged: true,
        hasAudio: true,
        resultVersion: 1,
      }),
    });
  });

  it('fails a workflow whose metadata names another image', async () => {
    dbMock.dbWrite.imageAudioScan.findFirst.mockResolvedValue({ imageId: 7 });
    mockGetWorkflow.mockResolvedValue({
      data: { status: 'succeeded', metadata: { imageId: 8 }, steps: [step(scanned(true))] },
    });

    await processAudioScanCallback('wf-1');

    const { data } = dbMock.dbWrite.imageAudioScan.updateMany.mock.calls[0][0];
    expect(data.status).toBe('Failed');
    expect(data).not.toHaveProperty('flagged');
  });

  it.each(['processing', undefined])(
    'throws for a %s read-back so the callback is retried, writing nothing',
    async (status) => {
      dbMock.dbWrite.imageAudioScan.findFirst.mockResolvedValue({ imageId: 7 });
      mockGetWorkflow.mockResolvedValue({
        data: { status, metadata: { imageId: 7 }, steps: [step(scanned(true))] },
      });

      await expect(processAudioScanCallback('wf-1')).rejects.toThrow();
      expect(dbMock.dbWrite.imageAudioScan.updateMany).not.toHaveBeenCalled();
    }
  );

  it.each(['failed', 'expired', 'canceled'])(
    'fails a %s workflow even with a readable output, leaving the flag unknown',
    async (status) => {
      dbMock.dbWrite.imageAudioScan.findFirst.mockResolvedValue({ imageId: 7 });
      mockGetWorkflow.mockResolvedValue({
        data: { status, metadata: { imageId: 7 }, steps: [step(scanned(false))] },
      });

      await processAudioScanCallback('wf-1');

      const { data } = dbMock.dbWrite.imageAudioScan.updateMany.mock.calls[0][0];
      expect(data.status).toBe('Failed');
      expect(data).not.toHaveProperty('flagged');
    }
  );
});

describe('submitVideoAudioScan', () => {
  const input = {
    imageId: 7,
    mediaUrl: 'https://image.test/v.mp4',
  };

  beforeEach(() => {
    mockIsFlipt.mockReset().mockResolvedValue(true);
    mockSubmit.mockReset().mockResolvedValue({ data: { id: 'wf-audio' }, attempts: 1 });
    dbMock.dbWrite.imageAudioScan.upsert.mockReset().mockResolvedValue({});
  });

  it('submits nothing while the flag is off', async () => {
    mockIsFlipt.mockResolvedValue(false);
    await submitVideoAudioScan(input);
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.imageAudioScan.upsert).not.toHaveBeenCalled();
  });

  it('a submitted scan is stored when its callback arrives', async () => {
    await submitVideoAudioScan(input);

    const { body } = mockSubmit.mock.calls[0][0];
    expect(new URL(body.callbacks[0].url).pathname).toBe('/api/webhooks/audio-scan-result');
    const { create, update } = dbMock.dbWrite.imageAudioScan.upsert.mock.calls[0][0];
    expect(create).toMatchObject({ imageId: 7, workflowId: 'wf-audio', status: 'Pending' });
    // A re-ingest clears the previous verdict.
    expect(update).toMatchObject({ workflowId: 'wf-audio', status: 'Pending', flagged: null });
    expect(update.result).toBe(Prisma.DbNull);

    dbMock.dbWrite.imageAudioScan.findFirst.mockResolvedValue({ imageId: 7 });
    dbMock.dbWrite.imageAudioScan.updateMany.mockResolvedValue({ count: 1 });
    mockGetWorkflow.mockResolvedValue({
      data: { status: 'succeeded', metadata: body.metadata, steps: [step(scanned(true))] },
    });
    await processAudioScanCallback('wf-audio');

    expect(dbMock.dbWrite.imageAudioScan.updateMany.mock.calls.at(-1)?.[0].data).toMatchObject({
      status: 'Succeeded',
      flagged: true,
    });
  });

  it('never throws, so the visual scan it rides beside is unaffected', async () => {
    mockSubmit.mockRejectedValue(new Error('orchestrator down'));
    await expect(submitVideoAudioScan(input)).resolves.toBeUndefined();

    mockSubmit.mockResolvedValue({ data: undefined, attempts: 3 });
    await expect(submitVideoAudioScan(input)).resolves.toBeUndefined();

    mockSubmit.mockResolvedValue({ data: { id: 'wf-audio' }, attempts: 1 });
    dbMock.dbWrite.imageAudioScan.upsert.mockRejectedValue(new Error('relation does not exist'));
    await expect(submitVideoAudioScan(input)).resolves.toBeUndefined();
  });
});

describe('createImageIngestionRequest with the audio scan on', () => {
  const request = {
    imageId: 7,
    url: 'https://image.civitai.com/x/v.mp4',
    type: 'video' as const,
    callbackUrl: 'https://civitai.test/api/webhooks/image-scan-result?token=t',
  };
  beforeEach(() => mockIsFlipt.mockReset().mockResolvedValue(true));

  it('returns the visual workflow without waiting on the audio submit', async () => {
    mockSubmit
      .mockReset()
      .mockResolvedValueOnce({ data: { id: 'wf-visual' }, attempts: 1 })
      .mockReturnValueOnce(new Promise(() => undefined));

    const result = await createImageIngestionRequest(request);

    expect(result.data).toEqual({ id: 'wf-visual' });
    await vi.waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2));
    expect(mockSubmit.mock.calls[1][0].body.steps[0].$type).toBe('audioModeration');
  });

  it.each([
    ['an image', { type: 'image' as const }, { data: { id: 'wf-visual' }, attempts: 1 }],
    ['no callback', { callbackUrl: undefined }, { data: { id: 'wf-visual' }, attempts: 1 }],
    ['a failed visual submit', {}, { data: undefined, attempts: 3 }],
  ])('submits no audio scan for %s', async (_case, overrides, visual) => {
    mockSubmit.mockReset().mockResolvedValue(visual);

    await createImageIngestionRequest({ ...request, ...overrides });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });
});

describe('parseAudioScanSteps with other steps in the workflow', () => {
  const transcription = (status: string) => ({ $type: 'transcription', status, output: {} });

  it('reads the verdict from its own succeeded step beside a failed transcription', () => {
    const verdict = { ...step(scanned(true)), status: 'succeeded' };

    expect(parseAudioScanSteps([transcription('failed'), verdict])).toMatchObject({
      ok: true,
      flagged: true,
    });
  });

  it('gives no verdict when the audioModeration step itself failed', () => {
    const verdict = { $type: 'audioModeration', status: 'failed' };

    expect(parseAudioScanSteps([transcription('succeeded'), verdict])).toMatchObject({
      ok: false,
    });
  });
});

describe('submitSongScan', () => {
  const input = { imageId: 9, mediaUrl: 'https://image.test/s.mp3' };

  beforeEach(() => {
    mockIsFlipt.mockReset().mockResolvedValue(false);
    mockSubmit.mockReset().mockResolvedValue({ data: { id: 'wf-song' }, attempts: 1 });
    dbMock.dbWrite.imageAudioScan.upsert.mockReset().mockResolvedValue({});
    dbMock.dbWrite.imageAudioScan.findUnique.mockReset().mockResolvedValue(null);
    dbMock.dbWrite.trackLyrics.findUnique.mockReset().mockResolvedValue(null);
    dbMock.dbWrite.entityModeration.findUnique.mockReset().mockResolvedValue(null);
    mockLyricsSubmit.mockReset().mockResolvedValue(undefined);
  });

  describe('for a song whose audio verdict is stored and whose lyrics verdict is missing', () => {
    beforeEach(() => {
      dbMock.dbWrite.imageAudioScan.findUnique.mockResolvedValue({
        status: 'Succeeded',
        workflowId: 'wf-audio-done',
      } as never);
      dbMock.dbWrite.trackLyrics.findUnique.mockResolvedValue({ imageId: 9 } as never);
    });

    it('re-sends only the lyrics scan, never the audio scan again', async () => {
      const result = await submitSongScan(input);

      expect(mockSubmit).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.imageAudioScan.upsert).not.toHaveBeenCalled();
      expect(mockLyricsSubmit).toHaveBeenCalledWith(9);
      // No attempt spent: the caller stamps the re-send, and a scan with no verdict is counted.
      expect(result).toEqual({ data: { id: 'wf-audio-done' }, attempts: 0 });
    });

    it('throws when no lyrics verdict will come, so the caller counts the attempt', async () => {
      mockLyricsSubmit.mockRejectedValue(new Error('lyrics scan not sent'));

      await expect(submitSongScan(input)).rejects.toThrow('lyrics scan not sent');
      expect(mockSubmit).not.toHaveBeenCalled();
    });

    it('sends nothing while the lyrics scan is in flight', async () => {
      dbMock.dbWrite.entityModeration.findUnique.mockResolvedValue({
        status: 'Pending',
        blocked: null,
      } as never);

      const result = await submitSongScan(input);

      expect(mockSubmit).not.toHaveBeenCalled();
      expect(mockLyricsSubmit).not.toHaveBeenCalled();
      expect(result.data).toEqual({ id: 'wf-audio-done' });
    });
  });

  it('scans the song even though the video flag is off, with no transcription step', async () => {
    await submitSongScan(input);

    const { body } = mockSubmit.mock.calls[0][0];
    expect(body.steps.map((s: { $type: string }) => s.$type)).toEqual(['audioModeration']);
    expect(body.steps[0].input).toEqual({ mediaUrl: input.mediaUrl, transcriber: 'auto' });
    expect(body.metadata).toMatchObject({ imageId: 9 });
    expect(new URL(body.callbacks[0].url).pathname).toBe('/api/webhooks/audio-scan-result');
    expect(mockIsFlipt).not.toHaveBeenCalled();
  });

  it('stores a pending row for the callback to settle', async () => {
    await submitSongScan(input);

    expect(dbMock.dbWrite.imageAudioScan.upsert.mock.calls[0][0].create).toMatchObject({
      imageId: 9,
      workflowId: 'wf-song',
      status: 'Pending',
    });
  });

  it('hands back the submit result and stores nothing when the orchestrator did not accept it', async () => {
    mockSubmit.mockResolvedValue({ data: undefined, attempts: 3, response: { status: 503 } });

    const result = await submitSongScan(input);

    expect(result.data).toBeUndefined();
    expect('response' in result ? result.response?.status : undefined).toBe(503);
    expect(dbMock.dbWrite.imageAudioScan.upsert).not.toHaveBeenCalled();
  });
});

describe('processAudioScanCallback by media type', () => {
  beforeEach(() => {
    mockGetWorkflow.mockReset();
    dbMock.dbWrite.imageAudioScan.findFirst.mockReset().mockResolvedValue({ imageId: 7 });
    dbMock.dbWrite.imageAudioScan.updateMany.mockReset().mockResolvedValue({ count: 1 });
    mockGetWorkflow.mockResolvedValue({
      data: { status: 'succeeded', metadata: { imageId: 7 }, steps: [step(scanned(true))] },
    });
  });

  it('hands a song on for its ingestion to be decided', async () => {
    dbMock.dbWrite.image.findUnique.mockReset().mockResolvedValue({ type: 'audio' } as never);

    const result = await processAudioScanCallback('wf-1');

    expect(result.song).toMatchObject({ imageId: 7, workflowId: 'wf-1' });
    expect(result.song?.parsed).toMatchObject({ ok: true, flagged: true });
  });

  it('keeps a video shadow-only: its verdict is stored on the scan row and never reaches the image', async () => {
    dbMock.dbWrite.image.findUnique.mockReset().mockResolvedValue({ type: 'video' } as never);

    const result = await processAudioScanCallback('wf-1');

    expect(result.song).toBeUndefined();
    expect(dbMock.dbWrite.imageAudioScan.updateMany).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('does not hand on a song whose result was already stored by an earlier callback', async () => {
    dbMock.dbWrite.image.findUnique.mockReset().mockResolvedValue({ type: 'audio' } as never);
    dbMock.dbWrite.imageAudioScan.updateMany.mockResolvedValue({ count: 0 });

    const result = await processAudioScanCallback('wf-1');

    expect(result.song).toBeUndefined();
  });

  it('gives a song no verdict when its workflow failed', async () => {
    dbMock.dbWrite.image.findUnique.mockReset().mockResolvedValue({ type: 'audio' } as never);
    mockGetWorkflow.mockResolvedValue({
      data: {
        status: 'failed',
        metadata: { imageId: 7 },
        steps: [{ $type: 'audioModeration', status: 'failed' }],
      },
    });

    const result = await processAudioScanCallback('wf-1');

    expect(result.song?.parsed).toMatchObject({ ok: false, failureType: 'workflow-failed' });
  });

  it('still fails a video whose workflow failed, whatever its step says', async () => {
    dbMock.dbWrite.image.findUnique.mockReset().mockResolvedValue({ type: 'video' } as never);
    mockGetWorkflow.mockResolvedValue({
      data: {
        status: 'failed',
        metadata: { imageId: 7 },
        steps: [{ ...step(scanned(false)), status: 'succeeded' }],
      },
    });

    await processAudioScanCallback('wf-1');

    expect(dbMock.dbWrite.imageAudioScan.updateMany.mock.calls[0][0].data.status).toBe('Failed');
  });

  it('hands on a failed song scan so it is retried, with the kind of failure', async () => {
    dbMock.dbWrite.image.findUnique.mockReset().mockResolvedValue({ type: 'audio' } as never);
    mockGetWorkflow.mockResolvedValue({
      data: { status: 'expired', metadata: { imageId: 7 }, steps: [] },
    });

    const result = await processAudioScanCallback('wf-1');

    expect(result.song?.parsed).toMatchObject({ ok: false, failureType: 'expired' });
  });
});

describe('createImageIngestionRequest for a song', () => {
  beforeEach(() => {
    mockIsFlipt.mockReset().mockResolvedValue(false);
    mockSubmit.mockReset().mockResolvedValue({ data: { id: 'wf-song' }, attempts: 1 });
    dbMock.dbWrite.imageAudioScan.upsert.mockReset().mockResolvedValue({});
    dbMock.dbWrite.image.findUnique.mockReset().mockResolvedValue({ metadata: {} } as never);
  });

  it('submits the song scan, never the video frame extraction', async () => {
    const result = await createImageIngestionRequest({
      imageId: 9,
      url: 'https://image.civitai.com/x/s.mp3',
      type: 'audio',
      callbackUrl: 'https://civitai.test/api/webhooks/image-scan-result?token=t',
    });

    expect(result.data).toEqual({ id: 'wf-song' });
    const steps = mockSubmit.mock.calls[0][0].body.steps.map((s: { $type: string }) => s.$type);
    expect(steps).toEqual(['audioModeration']);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
  });
});
