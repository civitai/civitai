import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as WorkflowsModule from '~/components/generation_v2/hooks/useGeneratedItemWorkflows';
import type * as WorkflowConfigModule from '~/shared/generation/config/workflows';

vi.mock('~/components/generation_v2/hooks/useGeneratedItemWorkflows', async (original) => ({
  ...(await original<typeof WorkflowsModule>()),
  useGeneratedItemWorkflows: () => ({
    groups: [
      {
        category: 'image',
        workflows: [{ id: 'img2img', graphKey: 'img2img', label: 'Image to image' }],
      },
    ],
  }),
}));

// Use a standalone workflow so this test exercises media forwarding without an ecosystem modal.
vi.mock('~/shared/generation/config/workflows', async (original) => ({
  ...(await original<typeof WorkflowConfigModule>()),
  getEcosystemsForWorkflow: () => [],
}));

import { MetadataExtractionFooter } from '~/components/Generation/footer-parts';
import { generationGraphStore } from '~/store/generation-graph.store';
import { useMetadataExtractionStore } from '~/store/metadata-extraction.store';

describe('metadata extraction footer media forwarding', () => {
  beforeEach(() => {
    useMetadataExtractionStore.getState().clear();
    vi.spyOn(generationGraphStore, 'setData').mockImplementation(() => undefined);
  });

  afterEach(() => {
    useMetadataExtractionStore.getState().clear();
    vi.restoreAllMocks();
  });

  test.each([
    { isVideo: false, fileUrl: 'data:image/png;base64,aW1hZ2U=' },
    { isVideo: true, fileUrl: 'blob:video-preview' },
  ])('forwards image input only when isVideo=$isVideo is false', async ({ isVideo, fileUrl }) => {
    useMetadataExtractionStore.setState({
      metadata: { prompt: 'extracted prompt' },
      params: { prompt: 'extracted prompt', seed: 123 },
      fileUrl,
      isVideo,
    });

    renderWithProviders(<MetadataExtractionFooter />);
    await page.getByRole('button', { name: 'Image to image', exact: true }).click();

    expect(generationGraphStore.setData).toHaveBeenCalledExactlyOnceWith({
      params: {
        prompt: 'extracted prompt',
        workflow: 'img2img',
        ...(isVideo ? {} : { images: [{ url: fileUrl }] }),
      },
      resources: [],
      runType: 'remix',
    });
  });
});
