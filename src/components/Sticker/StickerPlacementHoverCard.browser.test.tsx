import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { HOVER_DELAY_MS } from '~/components/UserAvatar/UserHoverCard';

/**
 * The card must not open on a pointer that is only passing over the sticker.
 *
 * A feed is swiped through, and a placed sticker is a small target inside it, so
 * the pointer crosses several stickers on the way to something else. What is
 * asserted is the WAIT — how long the card takes to appear — rather than that it
 * is absent at some instant, because an absence assertion passes for free the
 * day the locator stops matching.
 */
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));

// Held in its loading state deliberately: `data` mounts the creator card, which
// wants profile cosmetics, live metrics and edge media. The dropdown's own
// header renders either way, which is all this file needs to see.
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  return {
    ...actual,
    trpc: {
      ...actual.trpc,
      placement: {
        ...actual.trpc.placement,
        getStickerPlacementDetail: {
          useQuery: () => ({ data: undefined, isLoading: true, error: null }),
        },
      },
    },
  };
});

const { StickerPlacementHoverCard } = await import(
  '~/components/Sticker/StickerPlacementHoverCard'
);

const renderCard = async () => {
  renderWithProviders(
    <StickerPlacementHoverCard placementId={11} imageId={74}>
      <button type="button">sticker</button>
    </StickerPlacementHoverCard>
  );

  await expect.element(page.getByRole('button', { name: 'sticker' })).toBeInTheDocument();
};

describe('the placed-sticker hover card waits before it opens', () => {
  /**
   * The measurement only ever runs long — a slow box delays the open, it cannot
   * make it early — so this fails on a shortened delay and never on load. The
   * floor is under `HOVER_DELAY_MS` for that reason: it is asserting that a real
   * delay is in force, not stopwatching the exact constant.
   */
  test('takes the shared hover delay to appear', async () => {
    await renderCard();

    const start = performance.now();
    await page.getByRole('button', { name: 'sticker' }).hover();
    await expect.element(page.getByText('Placed')).toBeInTheDocument();
    const elapsed = performance.now() - start;

    expect(HOVER_DELAY_MS).toBeGreaterThanOrEqual(500);
    expect(elapsed).toBeGreaterThanOrEqual(HOVER_DELAY_MS * 0.8);
  });
});
