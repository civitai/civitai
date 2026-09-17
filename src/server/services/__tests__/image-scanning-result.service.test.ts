import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyImageScanFailure,
  ImageScanFailureClass,
} from '~/server/services/image-scan-failure';

const pipeline = vi.hoisted(() => ({
  applyIngestionSideEffects: vi.fn(),
  buildAndInsertScanTags: vi.fn(),
  extractFailedSteps: vi.fn(),
  loadImageForScan: vi.fn(),
  logPerceptualHashMatch: vi.fn(),
  markImageScanError: vi.fn(),
  readJobFailureReason: vi.fn(),
  resolveScanOutcome: vi.fn(),
  sendIngestionSignal: vi.fn(),
}));
const { mockRecordAudit, mockRemoveJobQueue, mockFanOut } = vi.hoisted(() => ({
  mockRecordAudit: vi.fn(),
  mockRemoveJobQueue: vi.fn(),
  mockFanOut: vi.fn(),
}));

// The pipeline imports the whole ingestion stack, and its stages run for real in
// image-scan-result.test.ts, so this suite pins only what this service passes them.
vi.mock('~/server/services/image-scan-pipeline', () => pipeline);
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  computePerceptualHash: (hash?: string) => (hash ? BigInt(`0x${hash}`) : undefined),
}));
vi.mock('~/server/services/scanner-audit.service', () => ({
  recordImageScanningResult: mockRecordAudit,
}));
vi.mock('~/server/services/job-queue.service', () => ({
  removeImageScanJobQueue: mockRemoveJobQueue,
}));
vi.mock('~/server/utils/webhook-debounce', () => ({ fanOutArticleImageUpdates: mockFanOut }));

import {
  IMAGE_SCANNING_LOG,
  isImageScanningWorkflow,
  parseImageScanningSteps,
  processImageScanningWorkflow,
} from '~/server/services/image-scanning-result.service';

const scanStep = {
  $type: 'imageScanning',
  name: 'scan',
  status: 'succeeded',
  output: {
    nsfwLevel: 'pg13',
    tagging: { ran: true, tags: [{ tag: 'solo', category: 'general', score: 0.9 }] },
    jointAgeClassification: { detections: [], minorDetected: false },
    csam: null,
  },
};
const failedScanStep = { ...scanStep, status: 'failed', output: undefined };
const hashStep = { $type: 'mediaHash', output: { hashes: { perceptual: '0A' } } };
const image = { id: 7, userId: 3, meta: { prompt: 'a prompt' } };

const deliver = (status: string, steps: unknown[]) =>
  processImageScanningWorkflow({
    workflowId: 'wf',
    status,
    steps,
    imageId: 7,
    articleImageScanning: true,
    startedAt: 'start',
    completedAt: 'end',
  });

// Every failure must be recorded exactly once: a second write bumps retryCount again and
// overwrites the failure type the retry ceiling is chosen from.
const expectOneScanError = (failure: Record<string, unknown>) => {
  expect(pipeline.markImageScanError).toHaveBeenCalledTimes(1);
  expect(pipeline.markImageScanError).toHaveBeenCalledWith(expect.objectContaining(failure));
  expect(pipeline.sendIngestionSignal).toHaveBeenCalledTimes(1);
  expect(pipeline.sendIngestionSignal).toHaveBeenCalledWith({
    imageId: 7,
    userId: 3,
    ingestion: 'Error',
    log: IMAGE_SCANNING_LOG,
  });
  expect(mockFanOut).toHaveBeenCalledWith(7);
  expect(pipeline.buildAndInsertScanTags).not.toHaveBeenCalled();
};

describe('processImageScanningWorkflow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pipeline.loadImageForScan.mockResolvedValue(image);
    pipeline.resolveScanOutcome.mockResolvedValue({
      ingestion: 'Scanned',
      blockedFor: null,
      reviewKey: null,
    });
    pipeline.markImageScanError.mockResolvedValue({ userId: 3, failureClass: 'unknown' });
    pipeline.extractFailedSteps.mockReturnValue(['scan']);
    pipeline.readJobFailureReason.mockResolvedValue('Failed to create container');
  });

  it('writes the scan through the shared pipeline without a hard block', async () => {
    await deliver('succeeded', [scanStep, hashStep]);

    expect(pipeline.logPerceptualHashMatch).toHaveBeenCalledWith({
      imageId: 7,
      pHash: 10n,
      log: IMAGE_SCANNING_LOG,
    });
    expect(pipeline.buildAndInsertScanTags).toHaveBeenCalledWith({
      imageId: 7,
      wdTags: { solo: 0.9 },
      ratingLevel: 'pg13',
      prompt: 'a prompt',
    });
    expect(pipeline.resolveScanOutcome).toHaveBeenCalledWith({
      image,
      pHash: 10n,
      workflowId: 'wf',
      prompt: 'a prompt',
      negativePrompt: undefined,
      log: IMAGE_SCANNING_LOG,
    });
    expect(mockRemoveJobQueue).toHaveBeenCalledWith([7]);
    expect(mockRecordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'wf',
        imageId: 7,
        startedAt: 'start',
        completedAt: 'end',
        scan: expect.objectContaining({ nsfwLevel: 'pg13', csam: null }),
      })
    );
    expect(pipeline.applyIngestionSideEffects).toHaveBeenCalledWith({
      image,
      outcome: expect.objectContaining({ ingestion: 'Scanned' }),
    });
    expect(mockFanOut).toHaveBeenCalledWith(7);
    expect(pipeline.markImageScanError).not.toHaveBeenCalled();
    expect(pipeline.sendIngestionSignal).toHaveBeenCalledTimes(1);
    expect(pipeline.sendIngestionSignal).toHaveBeenCalledWith({
      imageId: 7,
      userId: 3,
      ingestion: 'Scanned',
      blockedFor: null,
      log: IMAGE_SCANNING_LOG,
    });
  });

  it('signals the outcome the pipeline resolved, blocked included', async () => {
    pipeline.resolveScanOutcome.mockResolvedValue({
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      reviewKey: null,
    });
    await deliver('succeeded', [scanStep]);

    expect(pipeline.sendIngestionSignal).toHaveBeenCalledWith({
      imageId: 7,
      userId: 3,
      ingestion: 'Blocked',
      blockedFor: 'moderated',
      log: IMAGE_SCANNING_LOG,
    });
  });

  it.each([
    ['failed', 'workflow-failed'],
    ['expired', 'expired'],
    ['canceled', 'canceled'],
  ])('marks a %s workflow as one %s error', async (status, failureType) => {
    const steps = [failedScanStep];
    await deliver(status, steps);

    expect(pipeline.extractFailedSteps).toHaveBeenCalledWith(steps);
    expect(pipeline.readJobFailureReason).toHaveBeenCalledWith('wf');
    expect(pipeline.markImageScanError).toHaveBeenCalledWith({
      workflowId: 'wf',
      imageId: 7,
      status,
      failureType,
      failedSteps: ['scan'],
      reason: 'Failed to create container',
    });
    expectOneScanError({ failureType });
  });

  it('marks a succeeded workflow without tags as one unusable-result error', async () => {
    await deliver('succeeded', [
      { ...scanStep, output: { ...scanStep.output, tagging: { status: 'skipped', ran: false } } },
    ]);

    expectOneScanError({
      failureType: 'unusable-result',
      reason: expect.stringContaining('Tagging did not run'),
    });
    expect(pipeline.loadImageForScan).not.toHaveBeenCalled();
  });

  it('marks a processing failure as one processing-failed error', async () => {
    pipeline.buildAndInsertScanTags.mockRejectedValueOnce(new Error('tag insert failed'));
    await deliver('succeeded', [scanStep]);

    expect(pipeline.markImageScanError).toHaveBeenCalledTimes(1);
    expect(pipeline.markImageScanError).toHaveBeenCalledWith(
      expect.objectContaining({ failureType: 'processing-failed', reason: 'tag insert failed' })
    );
    expect(pipeline.sendIngestionSignal).toHaveBeenCalledTimes(1);
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['succeeded', [scanStep]],
    ['failed', [failedScanStep]],
  ])('leaves articles alone when article scanning is off (%s)', async (status, steps) => {
    await processImageScanningWorkflow({
      workflowId: 'wf',
      status,
      steps,
      imageId: 7,
      articleImageScanning: false,
    });
    expect(mockFanOut).not.toHaveBeenCalled();
  });

  it('lets a deleted image through for the route to acknowledge', async () => {
    pipeline.loadImageForScan.mockRejectedValueOnce(new Error('image not found: 7'));
    await expect(deliver('succeeded', [scanStep])).rejects.toThrow('image not found');
    expect(pipeline.markImageScanError).not.toHaveBeenCalled();
  });

  it('keeps the verdict when a side effect fails', async () => {
    mockRemoveJobQueue.mockRejectedValueOnce(new Error('queue down'));
    await deliver('succeeded', [scanStep]);

    expect(pipeline.markImageScanError).not.toHaveBeenCalled();
    expect(pipeline.sendIngestionSignal).toHaveBeenCalledWith(
      expect.objectContaining({ ingestion: 'Scanned' })
    );
  });
});

const detection = (ageBand: string, isMinor: boolean) => ({
  ageBand,
  isMinor,
  under18Probability: isMinor ? 0.8 : 0.1,
});

const scanOutput = (overrides: Record<string, unknown> = {}) => ({
  nsfwLevel: 'r',
  score: 0.8,
  topK: [],
  aiRecognition: { label: 'AI', score: 0.9 },
  animeRecognition: { label: 'real', score: 0.7 },
  tagging: {
    status: 'ran',
    ran: true,
    tags: [
      { tag: 'solo', category: 'general', score: 0.9 },
      { tag: 'lowres', category: 'meta', score: 0.8 },
      { tag: 'worst quality', category: 'quality', score: 0.8 },
      { tag: 'original', category: 'copyright', score: 0.8 },
      { tag: 'hatsune miku', category: 'character', score: 0.8 },
      { tag: 'questionable', category: 'rating', score: 0.8 },
    ],
  },
  jointAgeClassification: {
    status: 'ran',
    ran: true,
    detections: [detection('21-24', false)],
    minorDetected: false,
  },
  csam: false,
  ...overrides,
});

const parserHashStep = {
  $type: 'mediaHash',
  output: { hashes: { perceptual: '6F51B11C49611E0E' } },
};
const parserScanStep = (output: unknown) => ({ $type: 'imageScanning', output });
const frames = (...outputs: unknown[]) => ({
  $type: 'repeat',
  output: { steps: outputs.map(parserScanStep) },
});

const untaggedFrame = scanOutput({ tagging: { status: 'skipped', ran: false, tags: [] } });
const unratedFrame = scanOutput({ nsfwLevel: 'na' });

describe('parseImageScanningSteps', () => {
  it('reads an image scan, keeping only general tags', () => {
    expect(parseImageScanningSteps([parserScanStep(scanOutput()), parserHashStep], 'wf')).toEqual({
      nsfwLevel: 'r',
      tags: { solo: 0.9 },
      csam: false,
      ageDetections: [detection('21-24', false)],
      minorDetected: false,
      aiRecognition: { label: 'AI', score: 0.9 },
      animeRecognition: { label: 'real', score: 0.7 },
      perceptualHash: '6F51B11C49611E0E',
    });
  });

  const riskyFrame = scanOutput({
    nsfwLevel: 'x',
    csam: true,
    aiRecognition: { label: 'AI', score: 0.9 },
    animeRecognition: { label: 'anime', score: 0.95 },
    tagging: { ran: true, tags: [{ tag: 'solo', category: 'general', score: 0.7 }] },
    jointAgeClassification: {
      ran: true,
      detections: [detection('13-15', true)],
      minorDetected: true,
    },
  });
  const safeFrame = scanOutput({
    nsfwLevel: 'pg',
    csam: null,
    aiRecognition: { label: 'Real', score: 0.6 },
    animeRecognition: { label: 'real', score: 0.55 },
    tagging: { ran: true, tags: [{ tag: 'solo', category: 'general', score: 0.6 }] },
    jointAgeClassification: {
      ran: true,
      detections: [detection('21-24', false)],
      minorDetected: false,
    },
  });

  // Both orders, so a frame can only ever raise what the video reports.
  it.each([
    ['riskiest frame first', [riskyFrame, safeFrame]],
    ['riskiest frame last', [safeFrame, riskyFrame]],
  ])('combines video frames by their highest values (%s)', (_, frameOutputs) => {
    const scan = parseImageScanningSteps(
      [{ $type: 'videoFrameExtraction', output: { frames: [] } }, frames(...frameOutputs)],
      'wf'
    );

    expect(scan).toMatchObject({
      nsfwLevel: 'x',
      tags: { solo: 0.7 },
      csam: true,
      minorDetected: true,
      aiRecognition: { label: 'AI', score: 0.9 },
      animeRecognition: { label: 'anime', score: 0.95 },
    });
    expect(scan.ageDetections).toHaveLength(2);
    expect(scan.ageDetections).toEqual(
      expect.arrayContaining([detection('13-15', true), detection('21-24', false)])
    );
  });

  it('reports csam as absent only when no frame reported it', () => {
    const csamOf = (...values: unknown[]) =>
      parseImageScanningSteps([frames(...values.map((csam) => scanOutput({ csam })))], 'wf').csam;
    expect(csamOf(null, null)).toBeNull();
    expect(csamOf(null, false)).toBe(false);
    expect(csamOf(false, true, null)).toBe(true);
    expect(csamOf(true, false)).toBe(true);
  });

  it.each([
    ['tagging did not run', [parserScanStep(untaggedFrame)], 'Tagging did not run'],
    ['the rating is unavailable', [parserScanStep(unratedFrame)], 'media rating unavailable'],
    [
      'the rating is one this app does not know',
      [parserScanStep(scanOutput({ nsfwLevel: 'nc17' }))],
      'media rating unavailable (nc17)',
    ],
    ['one frame was not tagged', [frames(scanOutput(), untaggedFrame)], 'Tagging did not run'],
    ['one frame has no rating', [frames(scanOutput(), unratedFrame)], 'media rating unavailable'],
    [
      'the scan step has no output',
      [{ $type: 'imageScanning', status: 'failed' }],
      'Missing imageScanning output',
    ],
    [
      'a frame has no output',
      [
        {
          $type: 'repeat',
          output: { steps: [parserScanStep(scanOutput()), { $type: 'imageScanning' }] },
        },
      ],
      'Missing imageScanning output',
    ],
    ['no frames were extracted', [frames()], 'Missing imageScanning output'],
  ])('throws when %s', (_, steps, message) => {
    expect(() => parseImageScanningSteps(steps, 'wf')).toThrow(message);
  });

  // A permanent class stops retries after one attempt; none of these is a bad file.
  it.each([[[parserScanStep(untaggedFrame)]], [[parserScanStep(unratedFrame)]], [[frames()]]])(
    'throws an error the retry classifier keeps retrying',
    (steps) => {
      let reason = '';
      try {
        parseImageScanningSteps(steps, 'wf');
      } catch (error) {
        reason = (error as Error).message;
      }
      expect(reason).not.toBe('');
      expect(
        classifyImageScanFailure({ reason, failureType: 'unusable-result', failedSteps: [] })
      ).not.toBe(ImageScanFailureClass.Permanent);
    }
  );
});

describe('isImageScanningWorkflow', () => {
  it.each([
    ['a finished image scan', [parserScanStep(scanOutput()), parserHashStep], true],
    ['a failed image scan with no output', [{ $type: 'imageScanning', status: 'failed' }], true],
    ['a finished video scan', [frames(scanOutput())], true],
    [
      'a video scan that never produced frames',
      [{ $type: 'repeat', input: { template: { $type: 'imageScanning' } } }],
      true,
    ],
    [
      'a legacy image scan',
      [{ $type: 'wdTagging' }, { $type: 'mediaRating' }, parserHashStep],
      false,
    ],
    [
      'a legacy video scan',
      [
        { $type: 'repeat', input: { template: { $type: 'wdTagging' } } },
        { $type: 'repeat', input: { template: { $type: 'mediaRating' } } },
      ],
      false,
    ],
  ])('%s → %s', (_, steps, expected) => {
    expect(isImageScanningWorkflow(steps)).toBe(expected);
  });
});
