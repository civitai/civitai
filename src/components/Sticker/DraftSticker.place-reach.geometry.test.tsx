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

describe('Place on a draft low in a short media box', () => {
  test('is pressable inside the media box, not clipped below it', async () => {
    await renderAtViewport(
      // The carousel viewport clips at the bottom of the media box.
      <div style={{ position: 'relative', width: 380, height: 300, overflow: 'hidden' }}>
        <DraftSticker
          draft={{ ...draft, y: 0.7, scale: 0.2 }}
          art={art}
          selected
          dressed={resolveTreatment({ treatment: 'none', surface: 'detail', isPending: false })}
          price={PRICE}
          creatorMaxScale={0.4}
          freeOffer={{ instant: true }}
          ownerShare={undefined}
          ownerUsername="creator"
          onGesture={() => true}
        />
      </div>,
      PHONE_VIEWPORT
    );
    const place = () =>
      [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Place free'
      );
    await expect.poll(() => !!place()).toBe(true);

    await expect
      .poll(() => {
        const box = place()!.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !!hit && place()!.contains(hit);
      })
      .toBe(true);
  });
});
