import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequest, mockIsFlipt, mockRecordFlag, mockHasFlag } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockIsFlipt: vi.fn(),
  mockRecordFlag: vi.fn(),
  mockHasFlag: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/orchestrator.service', () => ({
  createXGuardModerationRequest: mockRequest,
}));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { SCAN_LABEL_QUEUE_WRITER: 'scan-label-queue-writer' },
  isFlipt: mockIsFlipt,
}));
vi.mock('~/server/services/scan-label-flag.service', () => ({
  recordScanLabelFlag: mockRecordFlag,
  hasScanLabelFlag: mockHasFlag,
}));
import {
  decideUploadPromptVerdict,
  labelUploadPrompt,
  scanUploadPrompt,
} from '~/server/services/upload-prompt-scan.service';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const result = (over: Record<string, unknown> = {}) => ({
  label: 'young',
  score: 0.1,
  threshold: 0.5,
  triggered: false,
  ...over,
});

describe('decideUploadPromptVerdict', () => {
  it('flags a prompt the scanner triggered on', () => {
    expect(decideUploadPromptVerdict({ results: [result({ triggered: true, score: 0.9 })] })).toBe(
      'flagged'
    );
  });

  it('flags a trigger reported only in triggeredLabels, in any casing', () => {
    expect(decideUploadPromptVerdict({ triggeredLabels: ['Young'], results: [result()] })).toBe(
      'flagged'
    );
  });

  it('passes a prompt the scanner answered on without triggering', () => {
    expect(decideUploadPromptVerdict({ results: [result()] })).toBe('clean');
  });

  it.each([
    ['no output', undefined],
    ['the label never answered', { results: [result({ label: 'sexual' })] }],
    ['the label errored', { results: [result({ error: 'scanner failed' })] }],
  ])('has no verdict when there is %s', (_, output) => {
    expect(decideUploadPromptVerdict(output)).toBe('unknown');
  });
});

describe('scanUploadPrompt', () => {
  beforeEach(() => vi.clearAllMocks());

  const scan = () =>
    scanUploadPrompt({ imageId: 1, userId: 2, prompt: 'a prompt', negativePrompt: 'neg' });

  it('scans the prompt and reads the verdict from the waited workflow', async () => {
    const output = { results: [result({ triggered: true })] };
    mockRequest.mockResolvedValue({ id: 'xg-1', steps: [{ $type: 'xGuardModeration', output }] });

    expect(await scan()).toEqual({ verdict: 'flagged', workflowId: 'xg-1', output });
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'prompt',
        positivePrompt: 'a prompt',
        negativePrompt: 'neg',
        labels: ['young'],
        callbackUrl: null,
      })
    );
  });

  it('has no verdict when the workflow is still running', async () => {
    mockRequest.mockResolvedValue({ steps: [{ $type: 'xGuardModeration' }] });

    expect((await scan()).verdict).toBe('unknown');
  });

  it('has no verdict, and does not throw, when the request fails', async () => {
    mockRequest.mockRejectedValue(new Error('network'));

    expect((await scan()).verdict).toBe('unknown');
  });
});

describe('labelUploadPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsFlipt.mockResolvedValue(true);
    mockHasFlag.mockResolvedValue(false);
  });

  const label = () =>
    labelUploadPrompt({ imageId: 1, userId: 2, prompt: 'a prompt', negativePrompt: 'neg' });
  const respond = (id: string | undefined, triggered: boolean) =>
    mockRequest.mockResolvedValue({
      id,
      steps: [
        {
          $type: 'xGuardModeration',
          output: { results: [result({ triggered, score: 0.8, matchedTerms: { text: ['x'] } })] },
        },
      ],
    });

  it('records a flagged prompt as an xguard-prompt label', async () => {
    respond('xg-1', true);

    await label();

    expect(mockRecordFlag).toHaveBeenCalledWith({
      imageId: 1,
      source: 'xguard-prompt',
      reason: 'young',
      workflowId: 'xg-1',
      flaggedAt: expect.any(Date),
      snapshot: { results: [{ label: 'young', score: 0.8, threshold: 0.5, triggered: true }] },
      oncePerImage: true,
    });
  });

  it('records nothing for a clean prompt', async () => {
    respond('xg-1', false);

    await label();

    expect(mockRecordFlag).not.toHaveBeenCalled();
  });

  it('records nothing for a flag with no workflow id to key it on', async () => {
    respond(undefined, true);

    await label();

    expect(mockRecordFlag).not.toHaveBeenCalled();
  });

  it('does not scan an image that already has a prompt label', async () => {
    mockHasFlag.mockResolvedValue(true);

    await label();

    expect(mockHasFlag).toHaveBeenCalledWith(1, 'xguard-prompt');
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('does not scan when it cannot tell whether a label exists', async () => {
    mockHasFlag.mockRejectedValue(new Error('relation does not exist'));

    await label();

    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('does not scan while the label queue writer is off', async () => {
    mockIsFlipt.mockResolvedValue(false);

    await label();

    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockRecordFlag).not.toHaveBeenCalled();
  });
});
