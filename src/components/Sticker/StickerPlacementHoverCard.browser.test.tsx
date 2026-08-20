import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { HOVER_DELAY_MS } from '~/components/UserAvatar/hover-card.constants';

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

/**
 * The module spread is load-bearing; the one that used to sit inside it was not.
 *
 * `...(await importOriginal())` carries `~/utils/trpc`'s OTHER exports —
 * `setTrpcBatchingEnabled` among them, which another module in this graph
 * imports. Dropping it is how a wholesale trpc mock takes a whole file down to
 * zero collected tests with nothing turning red, which is what
 * `local-rules/no-wholesale-module-mock` exists to stop.
 *
 * What was decoration is the inner `...actual.trpc`: `trpc` is a `createFlatProxy`
 * over a `noop` function with no `ownKeys` trap, so spreading it enumerates
 * nothing and yields `{}`. Removed rather than left in place looking protective.
 *
 * So what is below `trpc:` is a hand-listed stub of exactly the path under test,
 * held in its loading state deliberately — `data` mounts the creator card, which
 * wants profile cosmetics, live metrics and edge media, and the dropdown's own
 * header renders either way.
 *
 * ⚠️ Supplying `data` from here needs more than this: the card then renders
 * `ReportPlacement`, whose `HideNote` calls `trpc.useUtils()` and
 * `trpc.placement.setStickerCommentHidden.useMutation`. Add them explicitly.
 */
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: {
    placement: {
      getStickerPlacementDetail: {
        useQuery: () => ({ data: undefined, isLoading: true, error: null }),
      },
    },
  },
}));

const { StickerPlacementHoverCard } = await import(
  '~/components/Sticker/StickerPlacementHoverCard'
);

/**
 * Stamped by the target's own `mouseenter`, which is the event Mantine starts
 * the delay from.
 *
 * Timing from before `hover()` would credit Playwright's actionability checks,
 * scroll-into-view and CDP round-trips to the delay — several WS hops, which on
 * a loaded box can cover the floor by themselves and let a regression through.
 * Timing from after `hover()` returns has the opposite fault: the delay is
 * already running by then, so the measurement comes back short and the test
 * flakes red. The event is the only honest zero.
 */
let enteredAt = 0;

const renderCard = async () => {
  renderWithProviders(
    <StickerPlacementHoverCard placementId={11} imageId={74}>
      <button
        type="button"
        onMouseEnter={() => {
          enteredAt = performance.now();
        }}
      >
        sticker
      </button>
    </StickerPlacementHoverCard>
  );

  await expect.element(page.getByRole('button', { name: 'sticker' })).toBeInTheDocument();
};

describe('the placed-sticker hover card waits before it opens', () => {
  /**
   * The measurement only ever runs long — a slow box delays the open, it cannot
   * make it early — so this fails on a shortened delay and never on load.
   */
  test('takes the shared hover delay to appear', async () => {
    await renderCard();

    await page.getByRole('button', { name: 'sticker' }).hover();

    // 🔴 The explicit timeout is load-bearing. `expect.element` polls on a
    // 1000ms default that nothing in this repo raises — `component-setup` lifts
    // `vi.waitFor`, not this — and half of that budget is spent by design before
    // the dropdown can exist at all. On the saturated CI box the same file
    // describes, the remainder is not enough.
    await expect.element(page.getByText('Placed'), { timeout: 5000 }).toBeInTheDocument();
    const elapsed = performance.now() - enteredAt;

    expect(enteredAt).toBeGreaterThan(0);
    expect(HOVER_DELAY_MS).toBeGreaterThanOrEqual(500);
    // Tight enough to catch a regression to the 300ms this replaced, which a
    // floor drawn below that would let through.
    expect(elapsed).toBeGreaterThanOrEqual(HOVER_DELAY_MS * 0.9);
  });
});
