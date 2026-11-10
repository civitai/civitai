import { NsfwLevel } from '~/server/common/enums';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { IsClientProvider } from '~/providers/IsClientProvider';
import { StickerPlacementBar } from '~/components/Sticker/StickerPlacementBar';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
import { STICKER_EDITOR_ATTR } from '~/components/EmblaCarousel/watchTouchDrag';

/**
 * On a phone the bar sits in the image page's bottom sheet, which is slid down
 * with a transform while collapsed. A transformed ancestor is the containing
 * block for `position: fixed`, so a tray rendered in place opened below the
 * screen: the "+" did nothing anyone could see.
 */
const IMAGE_ID = 1;
const PHONE = { width: 390, height: 844 };
// What the collapsed sheet does on a 844px-tall phone, measured on civitai.com.
const SHEET_OFFSET_PX = 742;

vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useStickerPlacementCounts: () => ({ counts: {}, data: {}, isLoading: false, isError: false }),
  useStickerPlacements: () => ({
    byImage: new Map(),
    counts: {},
    isLoading: false,
    isError: false,
  }),
  useFreePlacementStanding: () => ({
    standing: { used: 1, remaining: 0, usedHere: false, resetsAt: new Date() },
    isLoading: false,
  }),
  useImagePlacementSpace: () => ({
    space: { mode: 'open', price: 100, ownerId: 999, freeSlots: 0, freeSlotsRemaining: 0 },
    isLoading: false,
  }),
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useOwnedSticker: () => ({ sticker: [], isLoading: false }),
  useStickerRefill: () => () => ({ refill: true }),
}));
vi.mock('~/components/Sticker/StickerHistoryPanel', () => ({
  StickerHistoryButton: () => null,
  StickerHistoryPanel: () => null,
}));
vi.mock('~/components/Sticker/StickerShopPanel', () => ({ StickerShopPanel: () => null }));
vi.mock('~/components/Sticker/StickerShopTile', () => ({ StickerShopTile: () => null }));
vi.mock('~/components/Sticker/use-sticker-drag-out', () => ({
  useStickerDragOut: () => ({ grab: () => undefined, dragging: false }),
}));
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ stickerPlacement: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({
    'cosmetic.getStickerBalances': { useQuery: () => ({ data: [] }) },
    'cosmetic.getStickerRecentUse': { useQuery: () => ({ data: [] }) },
    'cosmetic.getStickerOffers': { useQuery: () => ({ data: [] }) },
  }),
}));

const openTrayFrom = async (sheetTransform: string | undefined) => {
  await page.viewport(PHONE.width, PHONE.height);
  renderWithProviders(
    <IsClientProvider>
      {/* Full viewport height, like the sheet (`inset-0`): a fixed child pins to
          this box's bottom, which the slide puts below the screen. */}
      <div style={{ height: PHONE.height, transform: sheetTransform }}>
        <StickerPlacementBar imageId={IMAGE_ID} imageNsfwLevel={NsfwLevel.PG} />
      </div>
    </IsClientProvider>
  );
  await page.getByRole('button', { name: 'Place a sticker' }).click();
  const instruction = page.getByText(/Tap or drag a sticker onto the image/);
  await expect.element(instruction).toBeInTheDocument();
  const tray = document.querySelector(`[${STICKER_EDITOR_ATTR}]`);
  expect(tray && getComputedStyle(tray).position).toBe('fixed');
  return tray!.getBoundingClientRect();
};

// The harness loads no Tailwind utilities, and without them the tray is a static
// block in the flow and this question cannot be asked. Only the three classes
// that pin the tray, with Tailwind's own values.
const pinUtilities = document.createElement('style');
pinUtilities.textContent = '.fixed{position:fixed}.inset-x-0{left:0;right:0}.bottom-0{bottom:0}';
document.head.appendChild(pinUtilities);

describe('StickerPlacementBar — in the phone bottom sheet', () => {
  afterEach(() => {
    useStickerPlacementDraftStore.getState().closeTray();
  });

  test('opens the tray on screen though the sheet is slid down', async () => {
    const rect = await openTrayFrom(`translateY(${SHEET_OFFSET_PX}px)`);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(PHONE.height);
  });

  // Control: without the transform the same press must land on screen too, so a
  // failure above is the sheet's doing and not the harness's.
  test('opens the tray on screen outside the sheet', async () => {
    const rect = await openTrayFrom(undefined);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(PHONE.height);
  });

  // The portaled tray mounts after the first commit, so a registration that reads the
  // ref in an effect captures null and the buy button stops avoiding the tray.
  test('registers the tray element as the buy button obstacle', async () => {
    await openTrayFrom(undefined);
    const tray = document.querySelector(`[${STICKER_EDITOR_ATTR}]`);
    expect(tray).not.toBeNull();
    expect(useStickerPlacementDraftStore.getState().tray).toBe(tray);
  });
});
