import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestrationClient from '@civitai/orchestration-client';

/**
 * The real submitSearchUploadScan and retry wrapper; only the generated client's submitWorkflow
 * (the HTTP call) is replaced.
 */
const { mockClientSubmit } = vi.hoisted(() => ({ mockClientSubmit: vi.fn() }));

vi.mock('@civitai/orchestration-client', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationClient>()),
  submitWorkflow: mockClientSubmit,
}));
vi.mock('~/server/services/orchestrator/client', () => ({
  internalOrchestratorClient: {},
  createOrchestratorClient: vi.fn(() => ({})),
}));

import { submitSearchUploadScan } from '~/server/services/orchestrator/orchestrator.service';

const BLOB = 'https://orchestration.civitai.com/v2/consumer/blobs/b1';
const submittedBody = () => {
  expect(mockClientSubmit).toHaveBeenCalledTimes(1);
  return (mockClientSubmit.mock.calls[0][0] as { body: Record<string, unknown> }).body;
};

beforeEach(() => {
  mockClientSubmit.mockReset().mockResolvedValue({
    data: { id: 'wf-1' },
    response: new Response(null, { status: 200 }),
  });
});

describe('submitSearchUploadScan', () => {
  it('refuses a URL that is not an orchestrator blob, before any request', async () => {
    await expect(
      submitSearchUploadScan({ blobUrl: 'https://attacker.example/consumer/blobs/b1' })
    ).rejects.toThrow();
    expect(mockClientSubmit).not.toHaveBeenCalled();
  });

  it('submits the blob as a single imageScanning step, with no callback, marked as a search upload', async () => {
    await expect(submitSearchUploadScan({ blobUrl: BLOB })).resolves.toBe('wf-1');
    const body = submittedBody();
    // The imageScanning step's output carries the age classification and face detections the gate
    // reads; its input takes no switches for them, so the exact step is the contract.
    // The whole body, so an added callback (or any other field) fails too.
    expect(body).toEqual({
      externalId: expect.any(String),
      metadata: { searchUpload: true },
      arguments: {},
      currencies: [],
      steps: [{ $type: 'imageScanning', name: 'scan', priority: 'normal', input: { image: BLOB } }],
    });
  });
});
