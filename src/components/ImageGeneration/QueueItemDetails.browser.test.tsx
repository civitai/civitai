import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as MobileGenerator from '~/hooks/useMobileGenerator';

// The layout comes from the flag and media queries, which the test browser can't set.
let layout: 'mobile' | 'desktop' = 'mobile';
vi.mock('~/hooks/useMobileGenerator', async (importOriginal) => ({
  ...(await importOriginal<typeof MobileGenerator>()),
  useMobileGenerator: () => layout === 'mobile',
  useGeneratorLayout: () => layout,
}));

import { QueueItemDetails } from '~/components/ImageGeneration/QueueItem';

describe('QueueItemDetails', () => {
  test('on a phone, a sheet with the parameters', async () => {
    layout = 'mobile';
    renderWithProviders(<QueueItemDetails params={{ steps: 8, seed: 42 }} />);
    await page.getByRole('button', { name: 'Details' }).click();

    const sheet = page.getByRole('dialog', { name: 'Details' });
    await expect.element(sheet.getByText('Seed')).toBeInTheDocument();
  });

  test('on desktop, a popover with the parameters, toggled by its button', async () => {
    layout = 'desktop';
    renderWithProviders(<QueueItemDetails params={{ steps: 8, seed: 42 }} />);
    const button = page.getByRole('button', { name: 'Details' });
    await button.click();
    const seed = page.getByText('Seed');
    await expect.element(seed).toBeInTheDocument();
    // A popover, not the sheet: no 'Details' heading.
    await expect.element(page.getByText('Details', { exact: true })).not.toBeInTheDocument();

    await button.click();
    await expect.element(seed).not.toBeInTheDocument();
  });

  test('its button names itself on hover', async () => {
    layout = 'desktop';
    renderWithProviders(<QueueItemDetails params={{ seed: 42 }} />);
    await page.getByRole('button', { name: 'Details' }).hover();

    await expect.element(page.getByRole('tooltip')).toHaveTextContent('Details');

    // It steps aside while the popover it names is open.
    await page.getByRole('button', { name: 'Details' }).click();
    await expect.element(page.getByText('Seed')).toBeInTheDocument();
    await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument();
  });

  describe('when the image info popover already lists the generation settings', () => {
    const params = {
      workflow: 'txt2img',
      output_format: 'jpeg',
      ecosystem: 'Krea2',
      quantity: 1,
      cfgScale: 1,
      steps: 8,
      seed: 1712037009,
      sampler: 'Euler',
    };

    test('it drops what the image info repeats and keeps the rest', async () => {
      layout = 'desktop';
      renderWithProviders(<QueueItemDetails params={params} omitImageInfoParams />);
      await page.getByRole('button', { name: 'Details' }).click();

      await expect.element(page.getByText('Workflow')).toBeInTheDocument();
      await expect.element(page.getByText('Ecosystem')).toBeInTheDocument();
      await expect.element(page.getByText('Quantity')).toBeInTheDocument();
      await expect.element(page.getByText('Seed')).not.toBeInTheDocument();
      await expect.element(page.getByText('Steps')).not.toBeInTheDocument();
      await expect.element(page.getByText('Cfg scale')).not.toBeInTheDocument();
      await expect.element(page.getByText('Sampler')).not.toBeInTheDocument();
    });

    test('without the image info (pending, failed, blocked) it lists everything', async () => {
      layout = 'desktop';
      renderWithProviders(<QueueItemDetails params={params} />);
      await page.getByRole('button', { name: 'Details' }).click();

      await expect.element(page.getByText('Seed')).toBeInTheDocument();
      await expect.element(page.getByText('Steps')).toBeInTheDocument();
      await expect.element(page.getByText('Cfg scale')).toBeInTheDocument();
      await expect.element(page.getByText('Workflow')).toBeInTheDocument();
    });
  });
});
