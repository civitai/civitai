import { beforeEach, describe, expect, it, vi } from 'vitest';

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
