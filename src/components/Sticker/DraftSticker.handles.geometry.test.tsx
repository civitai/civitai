import { describe, expect, test, vi } from 'vitest';
import type * as CosmeticShopUtil from '~/components/CosmeticShop/cosmetic-shop.util';
import type * as PlacementUtil from '~/components/Sticker/placement.util';
import type * as StickerUtil from '~/components/Sticker/sticker.util';
import type * as Trpc from '~/utils/trpc';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { PHONE_VIEWPORT, renderAtViewport } from '../../../test/geometry-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';
import { resolveTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import type { StickerDraft } from '~/store/sticker-placement-draft.store';

// Everything the draft reaches for that is not its own geometry.
vi.mock('~/components/Sticker/placement.util', async (importOriginal) => ({
  ...(await importOriginal<typeof PlacementUtil>()),
  useCreateStickerPlacement: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({ label }: { label: string }) => <button type="button">{label}</button>,
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ id: 7 }) }));
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopUtil>()),
  useMutateCosmeticShop: () => ({ purchaseShopItem: vi.fn(), purchasingShopItem: false }),
}));
vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useBuyStickerUses: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof Trpc>()),
  trpc: makeTrpcProxy(
    {},
    { useUtils: () => ({ cosmetic: { getStickerBalances: { invalidate: vi.fn() } } }) }
  ),
}));
// A square artwork box, so the geometry does not depend on an image loading.
vi.mock('~/components/EdgeMedia/EdgeImage', () => ({
  EdgeImage: ({ style }: { style?: React.CSSProperties }) => (
    <div style={{ ...style, aspectRatio: '1' }} />
  ),
}));

const PRICE = 700;
const draft: StickerDraft = {
  id: 'draft-1',
  imageId: 74,
  cosmeticId: 85,
  x: 0.5,
  y: 0.4,
  scale: 0.4,
  rotation: 0,
  flip: false,
  opacity: 1,
};
const art = { id: 85, name: 'Star', slug: 'star', url: 'star.png' };
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
    await expect.poll(() => handles().length).toBe(5);
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
    await expect.poll(() => handles().length).toBe(5);
    const artwork = handles()[0].parentElement?.parentElement as HTMLElement;
    const { x, y } = centre(artwork.getBoundingClientRect());

    expect(handles()).not.toContain(document.elementFromPoint(x, y));

    // And each corner's ring leaves the side facing the body to the body.
    for (const handle of handles().filter((h) => h.getBoundingClientRect().width < 14)) {
      const dot = centre(handle.getBoundingClientRect());
      const inward = { x: dot.x + Math.sign(x - dot.x) * 12, y: dot.y + Math.sign(y - dot.y) * 12 };
      expect(document.elementFromPoint(inward.x, inward.y), 'inward of a corner').not.toBe(handle);
    }
  });
});
