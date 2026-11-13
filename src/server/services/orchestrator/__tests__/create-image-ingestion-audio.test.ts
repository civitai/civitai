import { describe, expect, it, vi } from 'vitest';

const { mockSubmit } = vi.hoisted(() => ({ mockSubmit: vi.fn() }));

vi.mock('@civitai/orchestration-client', async () => ({
  ...(await import('./civitai-client.stub')).civitaiClientStub(),
  getWorkflow: vi.fn(),
  submitWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflowWithRetry: mockSubmit,
}));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));
vi.mock('~/server/flipt/client', () => ({
  FLIPT_FEATURE_FLAGS: { IMAGE_INGESTION_IMAGE_SCANNING: 'x', VIDEO_AUDIO_SCAN: 'y' },
  isFlipt: vi.fn(async () => false),
}));
vi.mock('~/env/client', () => ({ env: { NEXT_PUBLIC_IMAGE_LOCATION: 'https://image.test' } }));

import { createImageIngestionRequest } from '~/server/services/orchestrator/orchestrator.service';

describe('createImageIngestionRequest — audio', () => {
  it('submits a song to its own scan workflow, not the video frame-extraction path', async () => {
    await createImageIngestionRequest({
      imageId: 7,
      url: 'https://image.civitai.com/x/song.mp3',
      type: 'audio',
    });
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    const { body } = mockSubmit.mock.calls[0][0];
    expect(body.metadata).toEqual({ imageId: 7, scan: 'song' });
  });
});
