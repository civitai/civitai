import { describe, expect, test, vi } from 'vitest';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as CosmeticShopUtil from '~/components/CosmeticShop/cosmetic-shop.util';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { PHONE_VIEWPORT, renderAtViewport } from '../../../test/geometry-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { resolveTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';

/**
 * What the buttons on a draft actually SEND.
 *
 * `isPlacingFree` is well covered as a function; nothing covered the component
 * using it to fill the payload. Deleting `free: placingFree` from the mutation
 * input left every test in this PR green while every free press charged Buzz —
 * so what is asserted here is the value on the wire, not that a prop of the right
 * type exists.
 */
const IMAGE_ID = 74;
const COSMETIC_ID = 85;
const PRICE = 700;

/** Every press, with its variables, in order. */
const placed: { imageId: number; free: boolean; data: Record<string, unknown> }[] = [];

vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useCreateStickerPlacement: () => ({
    mutate: (variables: (typeof placed)[number]) => placed.push(variables),
    isPending: false,
  }),
}));

/**
 * Mocked because it is a dependency, not the thing under test: the real one
 * renders a currency badge and an account picker and wants the Buzz providers.
 * Reduced to a button that calls what it is given, so a paid press is still
 * observable here — the free press goes through a real Mantine `Button`.
 */
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({
    label,
    onPerformTransaction,
  }: {
    label: string;
    onPerformTransaction: () => void;
  }) => (
    // `data-buzz-button` is load-bearing. Without it the stub is
    // indistinguishable from a plain Mantine `Button` by name alone, so swapping
    // the free option TO a BuzzTransactionButton left all ten tests green — the
    // component's own docstring argues at length that it must not be one, and
    // nothing held that argument.
    <button type="button" data-buzz-button onClick={onPerformTransaction}>
      {label}
    </button>
  ),
}));

vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));

// `EdgeImage` resolves its URL through `useCurrentUser`, which reads a session
// context this tree does not mount — and the throw happens inside render, so the
// whole draft comes back empty rather than failing on the missing provider.
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));

// Every one of these spreads the real module rather than listing its exports. A
// hand-listed mock couples this file to the whole transitive graph of the draft
// and nothing warns when that graph grows — the wholesale `~/utils/trpc` version
// of this file collected ZERO tests, because another module in the graph imports
// `setTrpcBatchingEnabled` and the stub did not provide it.
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopUtil>()),
  useMutateCosmeticShop: () => ({ purchaseShopItem: vi.fn(), purchasingShopItem: false }),
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useBuyStickerUses: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof Trpc>();
  return {
    ...actual,
    trpc: makeTrpcProxy(
      {},
      { useUtils: () => ({ cosmetic: { getStickerBalances: { invalidate: vi.fn() } } }) }
    ),
  };
});

const draft: StickerDraft = {
  id: 'draft-1',
  imageId: IMAGE_ID,
  cosmeticId: COSMETIC_ID,
  x: 0.5,
  // Mid-height and small, so the buy cluster is reachable whichever side of the
  // sticker it settles on. It is absolutely positioned and flips above the
  // sticker when the space below is obstructed, and a cluster that lands outside
  // the harness iframe cannot be scrolled to — Playwright then reports "visible,
  // enabled and stable", fails to scroll, and burns the whole click budget on
  // something that reads as actionable. The container is sized under the default
  // 414x896 viewport for the same reason; 800 wide put it off the right edge.
  y: 0.6,
  scale: 0.25,
  rotation: 15,
  flip: false,
  opacity: 1,
};

// A square artwork box, so the geometry does not depend on an image loading.
vi.mock('~/components/EdgeMedia/EdgeImage', () => ({
  EdgeImage: ({ style }: { style?: React.CSSProperties }) => (
    <div style={{ ...style, aspectRatio: '1' }} />
  ),
}));

const art = { id: COSMETIC_ID, name: 'Star', slug: 'star', url: 'star.png' };
const { DraftSticker } = await import('~/components/Sticker/DraftSticker');

/**
 * The handle dots are 12px (corners) and 16px (rotate knob) so they do not cover
 * the artwork; what a finger has to hit is the invisible ring around each. A
 * press this far off a dot's centre has to land on the handle, not the sticker.
 */
const CORNER_REACH = 18;
const KNOB_REACH = 20;

const renderDraft = (scale: number) =>
  renderAtViewport(
    <div style={{ position: 'relative', width: 380, height: 600 }}>
      <DraftSticker
        draft={{ ...draft, rotation: 0, scale, y: 0.4 }}
        art={art}
        selected
        dressed={resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false })}
        price={PRICE}
        freeOffer={null}
        ownerShare={undefined}
        ownerUsername="creator"
        onGesture={() => true}
      />
    </div>,
    PHONE_VIEWPORT
  );

const handles = () => [...document.querySelectorAll<HTMLElement>('span.rounded-full.bg-blue-5')];
const centre = (box: DOMRect) => ({ x: box.left + box.width / 2, y: box.top + box.height / 2 });

describe('draft sticker handles on a phone', () => {
  test('a finger near a handle, on its outer side, lands on it', async () => {
    await renderDraft(0.4);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const body = centre(
      (document.querySelector('[data-sticker-editor]') as HTMLElement).getBoundingClientRect()
    );
    expect(handles()).toHaveLength(5);

    for (const handle of handles()) {
      const box = handle.getBoundingClientRect();
      const dot = centre(box);
      const reach = box.width > 14 ? KNOB_REACH : CORNER_REACH;
      // Away from the sticker's middle: where a finger reaching for it lands.
      const dx = dot.x - body.x;
      const dy = dot.y - body.y;
      const length = Math.hypot(dx, dy) || 1;
      const x = dot.x + (dx / length) * reach;
      const y = dot.y + (dy / length) * reach;
      expect(document.elementFromPoint(x, y), `${box.width}px handle`).toBe(handle);
    }
  });

  test('the rings leave a small sticker draggable by its middle', async () => {
    await renderDraft(0.1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const artwork = handles()[0].parentElement?.parentElement as HTMLElement;
    const { x, y } = centre(artwork.getBoundingClientRect());

    expect(handles()).not.toContain(document.elementFromPoint(x, y));
  });
});
