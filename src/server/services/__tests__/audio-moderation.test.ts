import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@civitai/client';
import { dbMock } from '~/__tests__/mocks/db.mock';

const mocks = vi.hoisted(() => ({ getWorkflow: vi.fn(), submit: vi.fn(), flag: vi.fn() }));
vi.mock('@civitai/client', () => ({ getWorkflow: mocks.getWorkflow }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflowWithRetry: mocks.submit,
}));
vi.mock('~/server/flipt/client', () => ({
  isFlipt: mocks.flag,
  FLIPT_FEATURE_FLAGS: { POSTED_AUDIO_MODERATION: 'posted-audio-moderation' },
}));

import {
  handleAudioModerationCallback,
  processAudioModerationQueue,
  recordAudioModerationWorkflow,
} from '../audio-moderation.service';

const scan = {
  id: 1,
  attemptId: 'ff08957d-871c-4835-8fdf-c39a440e1c8a',
  workflowId: 'workflow-1',
  status: 'Pending',
  attempts: 1,
};
const output = {
  lyrics: 'Test transcript',
  sexualizedMinors: true,
  blocked: true,
  score: 0.9,
  model: 'test-model',
  policyHash: 'test-policy',
  hasAudio: true,
};
function workflow(result: unknown = output) {
  return {
    id: 'workflow-1',
    status: 'succeeded',
    metadata: { audioScanId: 1, audioScanAttempt: scan.attemptId },
    steps: [{ $type: 'audioModeration', name: 'audioScan', output: result }],
  } as unknown as Workflow;
}
beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.audioModerationScan.findFirst.mockResolvedValue(scan);
  dbMock.dbWrite.audioModerationScan.updateMany.mockResolvedValue({ count: 1 });
});

describe('audio moderation callback', () => {
  it('reads the authenticated workflow and records only shadow state', async () => {
    mocks.getWorkflow.mockResolvedValue({ data: workflow() });
    await handleAudioModerationCallback({ workflowId: 'workflow-1', output: { blocked: false } });
    expect(dbMock.dbWrite.audioModerationScan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, attemptId: scan.attemptId, status: 'Pending' },
        data: expect.objectContaining({ status: 'Succeeded', flagged: true, result: output }),
      })
    );
    expect(dbMock.dbWrite.image.updateMany).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.image.update).not.toHaveBeenCalled();
  });
  it('ignores stale or duplicate callbacks', async () => {
    dbMock.dbWrite.audioModerationScan.findFirst.mockResolvedValue(null);
    await recordAudioModerationWorkflow(workflow());
    expect(dbMock.dbWrite.audioModerationScan.updateMany).not.toHaveBeenCalled();
  });
  it('accepts a callback racing ahead of submit registration, with the attempt guard on the final write', async () => {
    dbMock.dbWrite.audioModerationScan.findFirst.mockResolvedValue({ ...scan, workflowId: null });
    await recordAudioModerationWorkflow(workflow());
    expect(dbMock.dbWrite.audioModerationScan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1, attemptId: scan.attemptId, status: 'Pending' },
      })
    );
  });
  it.each([
    null,
    {},
    { ...output, score: undefined },
    { ...output, blocked: false },
    { ...output, hasAudio: undefined },
  ])('fails incomplete or contradictory output: %j', async (result) => {
    await recordAudioModerationWorkflow(workflow(result));
    expect(dbMock.dbWrite.audioModerationScan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'Failed' }) })
    );
  });
  it('records no-audio as a skip rather than a classifier approval', async () => {
    await recordAudioModerationWorkflow(
      workflow({
        lyrics: '',
        sexualizedMinors: false,
        blocked: false,
        hasAudio: false,
        skippedReason: 'noAudioTrack',
      })
    );
    expect(dbMock.dbWrite.audioModerationScan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'Succeeded', flagged: null }),
      })
    );
  });
  it('leaves work queued while the rollout flag is off', async () => {
    mocks.flag.mockResolvedValue(false);
    expect(await processAudioModerationQueue()).toEqual({ processed: 0 });
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});

describe('audio moderation dispatch recovery', () => {
  const queued = {
    ...scan,
    workflowId: null,
    imageId: 7,
    sourceUrl: 'd49e5728-329c-42fc-904c-74b4197c8b64',
    updatedAt: new Date(),
    startedAt: null,
    attempts: 0,
  };
  beforeEach(() => {
    mocks.flag.mockResolvedValue(true);
    dbMock.dbWrite.audioModerationScan.findMany.mockResolvedValue([queued]);
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ url: queued.sourceUrl, type: 'video' });
  });

  it('does not submit when another dispatcher owns the row', async () => {
    dbMock.dbWrite.audioModerationScan.updateMany.mockResolvedValue({ count: 0 });
    await processAudioModerationQueue();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it('preserves the attempt identity after an uncertain submission', async () => {
    mocks.submit.mockRejectedValue(new Error('Connection lost'));
    await processAudioModerationQueue();
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          externalId: scan.attemptId,
          metadata: { audioScanId: 1, audioScanAttempt: scan.attemptId },
          steps: [
            expect.objectContaining({ input: expect.objectContaining({ transcriber: 'auto' }) }),
          ],
        }),
      }),
      expect.anything()
    );
    expect(dbMock.dbWrite.audioModerationScan.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { error: 'Connection lost' },
      })
    );
  });

  it('keeps the last uncertain submission eligible for its callback without submitting again', async () => {
    dbMock.dbWrite.audioModerationScan.findMany.mockResolvedValue([
      { ...queued, attempts: 5, startedAt: new Date() },
    ]);
    await processAudioModerationQueue();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.audioModerationScan.updateMany).toHaveBeenCalledTimes(1);
  });

  it('expires reconciliation even when the workflow endpoint is unavailable', async () => {
    dbMock.dbWrite.audioModerationScan.findMany.mockResolvedValue([
      {
        ...queued,
        attempts: 5,
        workflowId: 'workflow-1',
        startedAt: new Date(Date.now() - 3 * 60 * 60_000),
      },
    ]);
    await processAudioModerationQueue();
    expect(mocks.getWorkflow).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.audioModerationScan.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'Failed' }),
      })
    );
  });

  it('rejects a disallowed media URL before contacting orchestration', async () => {
    const sourceUrl = 'http://127.0.0.1/private';
    dbMock.dbWrite.audioModerationScan.findMany.mockResolvedValue([{ ...queued, sourceUrl }]);
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ url: sourceUrl, type: 'video' });
    await processAudioModerationQueue();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.audioModerationScan.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'Failed', error: 'Media URL is not allowed' }),
      })
    );
  });

  it('cancels a replaced upload without scanning the old source', async () => {
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ url: 'replacement', type: 'video' });
    await processAudioModerationQueue();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.audioModerationScan.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { status: 'Canceled', error: 'Media was removed or replaced' },
      })
    );
  });
});
