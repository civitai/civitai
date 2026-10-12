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
  nextLayout,
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
  useQueryStickerBalances: () => ({ data: [], isLoading: false }),
  useEquipProfileDecoration: () => ({ equip: vi.fn(), isLoading: false }),
}));

const { CosmeticShopItemPreviewModal } = await import('./CosmeticShopItemPreviewModal');

const cosmetic = {
  id: 1,
  name: 'Black Twintails',
  type: 'ContentDecoration',
  data: {},
  creator: { id: 5 },
};
const shopItem = {
  id: 1,
  title: 'Black Twintails',
  unitAmount: 3000,
  availableQuantity: null,
  availableFrom: null,
  meta: {},
  cosmetic,
} as unknown as CosmeticShopItemGetById;
// The tallest purchase block: the resale split and the pay-with selector both render above
// the button.
const resaleItem = {
  ...shopItem,
  meta: { sellerShare: 30, acceptsBlueBuzz: true },
} as unknown as CosmeticShopItemGetById;
const RESELLER = 99;

function findByText<T extends HTMLElement>(selector: string, text: RegExp) {
  return Array.from(document.querySelectorAll<T>(selector)).find((el) =>
    text.test(el.textContent ?? '')
  );
}

async function openModal(item: CosmeticShopItemGetById, vp: Viewport, viaShopUserId?: number) {
  await renderAtViewport(
    <CosmeticShopItemPreviewModal shopItem={item} viaShopUserId={viaShopUserId} />,
    vp
  );
  expect(cascadeEvidence().tailwindFlexUtilityResolves, 'the real cascade did not load').toBe(true);
  const purchase = await vi.waitUntil(() => findByText<HTMLButtonElement>('button', /^Purchase$/));
  const content = purchase.closest<HTMLElement>('.mantine-Modal-content');
  if (!content) throw new Error('modal content did not render');
  // Wait out the modal's open transition before measuring.
  await vi.waitUntil(
    () => getComputedStyle(content).opacity === '1' && document.getAnimations().length === 0,
    { timeout: 5000 }
  );
  // The modal really is taller than it is allowed to be, or nothing below is under pressure.
  expect(content.scrollHeight).toBeGreaterThan(content.clientHeight);
  // ...and whatever does not fit can still be scrolled to.
  expect(['auto', 'scroll']).toContain(getComputedStyle(content).overflowY);
  const warning = findByText<HTMLElement>('p', /This cosmetic is an equippable/);
  if (!warning) throw new Error('equippable warning did not render');
  if (item === resaleItem) {
    // The cases using it rely on it being the tallest block.
    expect(findByText('p', /Reseller earns/), 'resale split did not render').toBeTruthy();
    expect(
      document.querySelector('[aria-label="Choose how to pay"]'),
      'pay-with selector did not render'
    ).toBeTruthy();
  }
  return { purchase, content, warning };
}

/** Fully inside the modal and the viewport, and a click at its centre lands on it. */
function expectOnScreen(el: HTMLElement, content: HTMLElement, vp: Viewport, name: string) {
  const b = box(el);
  expect(b.height, `${name} has no height`).toBeGreaterThan(0);
  expect(b.top, `${name} is above the modal`).toBeGreaterThanOrEqual(box(content).top);
  expect(b.bottom, `${name} is below the modal`).toBeLessThanOrEqual(box(content).bottom);
  expect(b.bottom, `${name} is below the viewport`).toBeLessThanOrEqual(vp.height);
  const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
  expect(hit && el.contains(hit), `${name} is covered or clipped`).toBe(true);
}

describe('CosmeticShopItemPreviewModal with a tall preview', () => {
  // Side by side, the left column stretches to the preview's height, so the purchase block
  // would sit below the fold without being pinned.
  test.each([
    { item: shopItem, label: 'plain', vp: { width: 1440, height: 600 } },
    { item: shopItem, label: 'plain', vp: { width: 1440, height: 860 } },
    { item: resaleItem, label: 'resale + pay-with', vp: { width: 1440, height: 600 } },
  ])(
    'side by side ($label, $vp.width x $vp.height): price, Purchase and the equippable warning are on screen',
    async ({ item, vp }) => {
      const { purchase, content, warning } = await openModal(
        item,
        vp,
        item === resaleItem ? RESELLER : undefined
      );
      expectOnScreen(purchase, content, vp, 'Purchase');
      expectOnScreen(warning, content, vp, 'the equippable warning');
    }
  );

  // Stacked, the purchase block already sits above the preview, so this guards the phone
  // layout; on main it failed only on the modal not scrolling.
  test('stacked (390 x 600): Purchase and the equippable warning are on screen', async () => {
    const vp = { width: 390, height: 600 };
    const { purchase, content, warning } = await openModal(shopItem, vp);
    expectOnScreen(purchase, content, vp, 'Purchase');
    expectOnScreen(warning, content, vp, 'the equippable warning');
  });

  // A phone on its side: the purchase block does not fit under the header, and pinning it
  // would cover the close button. It stays in the flow and the modal scrolls to it.
  test('stacked and short (740 x 360): the close button stays clear and Purchase scrolls into view', async () => {
    const vp = { width: 740, height: 360 };
    const { purchase, content, warning } = await openModal(resaleItem, vp, RESELLER);
    const close = Array.from(
      content.querySelectorAll<HTMLButtonElement>('button.mantine-CloseButton-root')
    ).find((b) => getComputedStyle(b).display !== 'none');
    if (!close) throw new Error('no visible close button');
    expectOnScreen(close, content, vp, 'the close button');

    purchase.scrollIntoView({ block: 'center' });
    await nextLayout();
    expectOnScreen(purchase, content, vp, 'Purchase');
    warning.scrollIntoView({ block: 'center' });
    await nextLayout();
    expectOnScreen(warning, content, vp, 'the equippable warning');
  });
});
