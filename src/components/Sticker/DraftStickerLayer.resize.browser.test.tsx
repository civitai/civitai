import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as CosmeticShopUtil from '~/components/CosmeticShop/cosmetic-shop.util';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import {
  STICKER_PLACEMENT_DEFAULT_SCALE,
  STICKER_PLACEMENT_MIN_SCALE,
} from '~/shared/utils/sticker-placement';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

/**
 * Dragging a resize handle as far as it goes must stop AT the creator's limit,
 * not a rounding step past it: the server refuses anything strictly above.
 */
const IMAGE_ID = 74;
const COSMETIC_ID = 85;
const CAP = 0.22;
const art = { id: COSMETIC_ID, name: 'Star', slug: 'star', url: 'star.png' };

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/components/Sticker/treatments/useStickerTreatment', () => ({
  useStickerTreatment: () => 'none',
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopUtil>()),
  useMutateCosmeticShop: () => ({ purchaseShopItem: vi.fn(), purchasingShopItem: false }),
}));
vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useCreateStickerPlacement: () => ({ mutate: vi.fn(), isPending: false }),
  useImagePlacementSpace: () => ({ space: { price: 0, settings: { maxScale: CAP } } }),
  useFreePlacementStanding: () => ({ standing: undefined }),
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useOwnedSticker: () => ({ sticker: [art] }),
  useStickerCosmetics: () => ({ sticker: [] }),
  useStickerRefill: () => () => undefined,
  useBuyStickerUses: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy({ 'cosmetic.getStickerBalances': { useQuery: () => ({ data: undefined }) } }),
}));

const { DraftStickerLayer } = await import('~/components/Sticker/DraftStickerLayer');

const pointer = (type: string, init: { x: number; y: number }, target: EventTarget) =>
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: init.x,
      clientY: init.y,
    })
  );

const dragHandle = async (width: number, toward: 'far' | 'anchor') => {
  const height = Math.round(width * 0.75);
  renderWithProviders(
    <div
      data-testid="surface"
      ref={(element) => useStickerPlacementDraftStore.getState().setSurface(element)}
      style={{ position: 'relative', width, height }}
    >
      <DraftStickerLayer />
    </div>
  );

  const { begin } = useStickerPlacementDraftStore.getState();
  useStickerPlacementDraftStore.setState({ targetImageId: IMAGE_ID });
  begin(COSMETIC_ID, { x: 0.3, y: 0.3 }, CAP);

  const handle = await vi.waitFor(() => {
    const el = document.querySelector<HTMLElement>(
      'span.cursor-nwse-resize.-bottom-1\\.5.-right-1\\.5'
    );
    if (!el) throw new Error('no handle yet');
    return el;
  });
  const surface = document.querySelector('[data-testid="surface"]')!.getBoundingClientRect();
  const start = handle.getBoundingClientRect();
  pointer('pointerdown', { x: start.x + 6, y: start.y + 6 }, handle);
  const end =
    toward === 'far'
      ? { x: surface.right + 500, y: surface.bottom + 500 }
      : { x: surface.left + (0.3 - STICKER_PLACEMENT_DEFAULT_SCALE / 2) * width, y: start.y + 6 };
  pointer('pointermove', end, window);
  pointer('pointerup', end, window);

  return useStickerPlacementDraftStore.getState().drafts[0];
};

beforeEach(() => {
  useStickerPlacementDraftStore.setState({
    drafts: [],
    selectedDraftId: null,
    targetImageId: null,
  });
});

describe('resizing a draft to the creator limit', () => {
  // 111, 114 and 148 are widths where (0.22 * w) / w is above 0.22 in floating point.
  test.each([111, 114, 148])('stops exactly at the limit on a %ipx-wide image', async (width) => {
    const resized = await dragHandle(width, 'far');

    expect(resized.scale).toBeLessThanOrEqual(CAP);
    expect(resized.scale).toBeCloseTo(CAP, 10);
  });
});

describe('resizing a draft to the floor', () => {
  // (0.05 * w) / w is below 0.05 at these widths, and the schema refuses a scale under the floor.
  test.each([162, 167, 172])('stops at or above the floor on a %ipx-wide image', async (width) => {
    const resized = await dragHandle(width, 'anchor');

    expect(resized.scale).toBeGreaterThanOrEqual(STICKER_PLACEMENT_MIN_SCALE);
  });
});
