import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { GeneratedOutputActions } from '~/components/ImageGeneration/GeneratedOutputActions';
import type { BlobData } from '~/shared/orchestrator/workflow-data';

// The Improve menu lists workflows from the generation config; one is enough to show its button.
vi.mock('~/components/generation_v2/hooks/useGeneratedItemWorkflows', () => ({
  useGeneratedItemWorkflows: () => ({ groups: [{ workflows: [{ key: 'upscale' }] }] }),
}));
vi.mock('~/components/generation_v2/GeneratedItemWorkflowMenu', () => ({
  GeneratedItemWorkflowMenu: () => null,
}));
vi.mock('~/components/ImageGeneration/GeneratedOutputRemixMenu', () => ({
  GeneratedOutputRemixMenu: () => <button>Remix source</button>,
}));

const output = {
  id: 'out-1.jpeg',
  url: 'https://example.test/out-1.jpeg',
  mediaType: 'image',
  ecosystemKey: 'SDXL',
  canUse: () => true,
} as unknown as BlobData;

function renderActions(compact: boolean) {
  renderWithProviders(
    <GeneratedOutputActions
      output={output}
      state={{}}
      compact={compact}
      infoSlot={<button>Details</button>}
      onToggleFavorite={vi.fn()}
      onToggleFeedback={vi.fn()}
    />
  );
}

describe('GeneratedOutputActions', () => {
  test('a tile everywhere else has every action', async () => {
    renderActions(false);
    await expect.element(page.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Remix source' })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Details' })).toBeInTheDocument();
  });

  test('a tile in the mobile generator keeps four; the rest are in its menu and the lightbox', async () => {
    renderActions(true);
    for (const name of ['Favorite', 'Like', 'Dislike', 'Improve'])
      await expect.element(page.getByRole('button', { name, exact: true })).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Remix source' }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: 'Details' })).not.toBeInTheDocument();
  });
});
