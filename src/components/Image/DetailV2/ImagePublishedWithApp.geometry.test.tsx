/**
 * The image detail sidebar's "Made with" card is exactly as wide as the cards beside it.
 *
 * Width comes from the stylesheet, so this is a geometry test: the component tier loads none, and
 * a wrapper's padding would be inert there. The column mirrors the sidebar's (`flex flex-col
 * gap-3` at 450px minus its `p-3`); the neighbour is a plain block as wide as the creator card.
 */
import { describe, expect, test, vi } from 'vitest';
import type * as TrpcModule from '~/utils/trpc';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import { nextLayout, renderAtViewport } from '../../../../test/geometry-setup';

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => ({ appBlocksPages: false }),
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof TrpcModule>()),
    trpc: makeTrpcProxy({
      'image.getPublishedWithApp': {
        useQuery: () => ({
          data: { slug: 'character-sheet-studio', name: 'Character Sheet Studio', iconUrl: null },
        }),
      },
      'appListings.getAppCard': {
        useQuery: () => ({ data: { id: 'l1', slug: 'character-sheet-studio', name: 'Card' } }),
      },
    }),
  };
});

// The real card needs a dozen unrelated providers and has its own tests; what is measured here is
// the box the image page puts it in, so the card is a plain block that fills what it is given.
vi.mock('~/components/Apps/AppListingCard', () => ({
  AppListingCard: () => <div data-testid="stub-listing-card" style={{ height: 120 }} />,
}));

import { ImagePublishedWithApp } from '~/components/Image/DetailV2/ImagePublishedWithApp';

const box = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!.getBoundingClientRect();

describe('image detail sidebar: the Made with card', () => {
  test('is exactly as wide as the card beside it, and starts at the same left edge', async () => {
    await renderAtViewport(
      <div style={{ width: 450 - 24 }}>
        <div className="flex flex-col gap-3 py-3">
          <div data-testid="neighbour" className="rounded-xl" style={{ height: 80 }} />
          <ImagePublishedWithApp imageId={1} />
        </div>
      </div>,
      { width: 1440, height: 900 }
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="stub-listing-card"]')).not.toBeNull()
    );
    await nextLayout();
    const neighbour = box('neighbour');
    const card = box('stub-listing-card');
    expect(card.width, 'the card is narrower than its neighbour').toBe(neighbour.width);
    expect(card.left, 'the card is inset from its neighbour').toBe(neighbour.left);
  });
});
