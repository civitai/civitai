import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as MobileGenerator from '~/hooks/useMobileGenerator';
import type * as FeatureFlags from '~/providers/FeatureFlagsProvider';
import type * as GenerationUtils from '~/components/ImageGeneration/GenerationForm/generation.utils';
import type { GenerationResourceValue } from '~/shared/types/generation.types';

// The layout comes from the flag and media queries, which the test browser can't set.
let layout: 'mobile' | 'desktop' = 'mobile';
vi.mock('~/hooks/useMobileGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileGenerator>()),
  useMobileGenerator: () => layout === 'mobile',
  useGeneratorLayout: () => layout,
}));
// The resource chips read the generation config for unstable resources; none here.
vi.mock('~/components/ImageGeneration/GenerationForm/generation.utils', async (importOriginal) => ({
  ...(await importOriginal<typeof GenerationUtils>()),
  useGenerationConfig: () => ({ unstableResources: [] }),
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlags>()),
  useFeatureFlags: () => ({}),
}));

import { QueueItemDetails } from '~/components/ImageGeneration/QueueItem';

const resource = {
  id: 11,
  name: 'Base',
  model: { id: 1, name: 'Z Image Turbo', type: 'Checkpoint' },
  baseModel: 'ZImageTurbo',
  canGenerate: true,
} as unknown as GenerationResourceValue;

describe('QueueItemDetails', () => {
  test('on a phone, a sheet with the prompt, the resources and the parameters', async () => {
    layout = 'mobile';
    renderWithProviders(
      <QueueItemDetails
        prompt="a fox in the snow"
        params={{ steps: 8, seed: 42 }}
        resources={[resource]}
        downloadsByVersion={new Map()}
      />
    );
    await page.getByRole('button', { name: 'Details' }).click();

    const sheet = page.getByRole('dialog', { name: 'Details' });
    await expect.element(sheet.getByText('a fox in the snow')).toBeInTheDocument();
    await expect.element(sheet.getByText('Z Image Turbo')).toBeInTheDocument();
    await expect.element(sheet.getByText('Seed')).toBeInTheDocument();
  });

  test('on desktop, a popover with the parameters, toggled by its button', async () => {
    layout = 'desktop';
    renderWithProviders(
      <QueueItemDetails
        params={{ steps: 8, seed: 42 }}
        resources={[]}
        downloadsByVersion={new Map()}
      />
    );
    const button = page.getByRole('button', { name: 'Details' });
    await button.click();
    const seed = page.getByText('Seed');
    await expect.element(seed).toBeInTheDocument();
    // A popover, not the sheet: no 'Details' heading.
    await expect.element(page.getByText('Details', { exact: true })).not.toBeInTheDocument();

    await button.click();
    await expect.element(seed).not.toBeInTheDocument();
  });
});
