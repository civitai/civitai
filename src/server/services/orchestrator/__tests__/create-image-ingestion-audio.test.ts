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
  it('refuses a song rather than sending it down the video frame-extraction path', async () => {
    await expect(
      createImageIngestionRequest({
        imageId: 7,
        url: 'https://image.civitai.com/x/song.mp3',
        type: 'audio',
      })
    ).rejects.toThrow(/audio/i);
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
