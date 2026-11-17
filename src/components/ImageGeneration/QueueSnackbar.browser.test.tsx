import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import type * as GenerationProviderModule from '~/components/ImageGeneration/GenerationProvider';

// The queue's state, as the generation provider would hand it over: two jobs in a four-slot queue.
const queued = [
  { status: 'processing', quantity: 2, complete: 1, processing: 1 },
  { status: 'processing', quantity: 2, complete: 0, processing: 2 },
];
vi.mock('~/components/ImageGeneration/GenerationProvider', async (orig) => ({
  ...(await orig<typeof GenerationProviderModule>()),
  useGenerationContext: <T,>(selector: (state: Record<string, unknown>) => T) =>
    selector({
      queued,
      queueStatus: 'processing',
      requestLimit: 4,
      requestsRemaining: 2,
      requestsLoading: false,
      userTier: 'gold',
    }),
}));
// The mobile generator lives at /generate, where the desktop snackbar drops its queue link.
vi.mock('next/router', () => ({ useRouter: () => ({ pathname: '/generate' }) }));

import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { generationGraphPanel } from '~/store/generation-graph.store';

describe('QueueSnackbar in the mobile generator', () => {
  test('shows every slot above Generate, and "queue" closes the form onto it', async () => {
    const setView = vi.spyOn(generationGraphPanel, 'setView').mockImplementation(() => undefined);
    renderWithProviders(<QueueSnackbar mobile />);

    await expect.element(page.getByText('2 jobs in')).toBeVisible();
    expect(document.querySelectorAll('[data-slot]')).toHaveLength(4);
    expect(document.querySelectorAll('[data-slot="processing"]')).toHaveLength(2);

    await page.getByText('queue', { exact: true }).click();
    expect(setView).toHaveBeenCalledWith('queue');
  });
});
