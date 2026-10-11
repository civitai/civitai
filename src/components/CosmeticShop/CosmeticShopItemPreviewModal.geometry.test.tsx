/**
 * Shop item preview modal at a SHORT viewport with a TALL preview.
 *
 * A content decoration previews on the buyer's own image at its natural aspect ratio, so a
 * portrait image makes the modal taller than the viewport. The modal used to set
 * `overflow: hidden` on its content, which clipped the bottom of the left column — the price and
 * the Purchase button — with no way to scroll to them.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  box,
  cascadeEvidence,
  renderAtViewport,
  type Viewport,
} from '../../../test/geometry-setup';
import type { CosmeticShopItemGetById } from '~/types/router';

// Taller than any viewport below, standing in for a portrait image of the buyer's.
const PREVIEW_HEIGHT = 900;

vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: () => undefined }),
}));
vi.mock('~/components/CosmeticShop/CosmeticPreview', () => ({
  CosmeticPreview: () => <div style={{ height: PREVIEW_HEIGHT }} />,
}));
vi.mock('~/components/Shop/CosmeticSample', () => ({
  CosmeticSample: () => <div style={{ width: 120, height: 120 }} />,
}));
// The real one reads Buzz balances; a fixed-height button is all the layout needs.
vi.mock('~/components/Buzz/BuzzTransactionButton', () => ({
  BuzzTransactionButton: ({ label }: { label: string }) => (
    <button type="button" style={{ height: 36 }}>
      {label}
    </button>
  ),
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', () => ({
  useMutateCosmeticShop: () => ({ purchaseShopItem: vi.fn(), purchasingShopItem: false }),
}));
vi.mock('~/components/Cosmetics/cosmetics.util', () => ({
  useQueryUserCosmetics: () => ({ data: {}, isLoading: false }),
  useEquipProfileDecoration: () => ({ equip: vi.fn(), isLoading: false }),
}));

const { CosmeticShopItemPreviewModal } = await import('./CosmeticShopItemPreviewModal');

const shopItem = {
  id: 1,
  title: 'Black Twintails',
  unitAmount: 3000,
  availableQuantity: null,
  availableFrom: null,
  meta: {},
  cosmetic: { id: 1, name: 'Black Twintails', type: 'ContentDecoration', data: {}, creator: null },
} as unknown as CosmeticShopItemGetById;

const VIEWPORTS: Viewport[] = [
  { width: 1440, height: 600 },
  { width: 1440, height: 860 },
  { width: 390, height: 600 },
];

describe('CosmeticShopItemPreviewModal with a tall preview', () => {
  test.each(VIEWPORTS)(
    'the Purchase button is on screen and clickable at $width x $height',
    async (vp) => {
      await renderAtViewport(<CosmeticShopItemPreviewModal shopItem={shopItem} />, vp);
      expect(cascadeEvidence().tailwindFlexUtilityResolves, 'the real cascade did not load').toBe(
        true
      );

      const purchase = await vi.waitUntil(() =>
        Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
          (b) => b.textContent?.trim() === 'Purchase'
        )
      );
      const content = purchase.closest<HTMLElement>('.mantine-Modal-content');
      if (!content) throw new Error('modal content did not render');

      // Wait out the modal's open transition before measuring.
      await vi.waitUntil(
        () => getComputedStyle(content).opacity === '1' && document.getAnimations().length === 0,
        { timeout: 5000 }
      );

      // The modal really is taller than it is allowed to be, or nothing below is under pressure.
      expect(content.scrollHeight).toBeGreaterThan(content.clientHeight);
      // ...and the rest of it (the preview's thumbnails) can still be scrolled to.
      expect(['auto', 'scroll']).toContain(getComputedStyle(content).overflowY);

      const button = box(purchase);
      expect(button.height).toBeGreaterThan(0);
      expect(button.top).toBeGreaterThanOrEqual(box(content).top);
      expect(button.bottom).toBeLessThanOrEqual(box(content).bottom);
      expect(button.bottom).toBeLessThanOrEqual(vp.height);
      // Nothing painted over it: a click at its centre lands on it.
      const hit = document.elementFromPoint(
        button.left + button.width / 2,
        button.top + button.height / 2
      );
      expect(hit && purchase.contains(hit), 'the Purchase button is covered or clipped').toBe(true);
    }
  );
});
