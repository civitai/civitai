/**
 * The home page's shop-section block lays its cards out in rows, at most two of them.
 *
 * `.grid` flows by column (other blocks fill a column of two before moving right), and the shop
 * block opts into row flow with `.gridRow`. That opt-in lost the cascade to `.grid`, so six cards
 * filled three columns of two and left the rest of a wide row empty.
 */
import { describe, expect, test, vi } from 'vitest';
import { constants } from '~/server/common/constants';
import { box, nextLayout, renderAtViewport } from '../../../test/geometry-setup';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

const ITEM_COUNT = 6;
const items = Array.from({ length: ITEM_COUNT }, (_, i) => ({
  createdAt: new Date('2026-10-01'),
  shopItem: { id: i + 1, title: `Item ${i + 1}`, addedById: null, cosmetic: null },
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  trpc: makeTrpcProxy({
    'homeBlock.getHomeBlock': {
      useQuery: () => ({
        data: { cosmeticShopSection: { title: 'Halloween', description: null, items } },
        isLoading: false,
      }),
    },
  }),
}));
vi.mock('~/components/HiddenPreferences/HiddenPreferencesProvider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHiddenPreferencesContext: () => ({ blockRelations: new Map(), hiddenLoading: false }),
}));
vi.mock('~/components/Shop/ShopItem', () => ({
  ShopItem: ({ item }: { item: { title: string } }) => (
    <div data-card style={{ height: 300 }}>
      {item.title}
    </div>
  ),
}));

const { CosmeticShopSectionHomeBlock } = await import('./CosmeticShopSectionHomeBlock');
const { MasonryProvider } = await import('~/components/MasonryColumns/MasonryProvider');

async function cardBoxes(width: number) {
  await renderAtViewport(
    // The home page's FeedLayout provider, without its ad unit.
    <MasonryProvider columnWidth={constants.cardSizes.model} className="z-10 m-0 flex-1">
      <CosmeticShopSectionHomeBlock
        homeBlockId={1}
        metadata={{ cosmeticShopSection: { id: 1, maxItems: ITEM_COUNT } }}
      />
    </MasonryProvider>,
    { width, height: 1000 }
  );
  // MasonryProvider debounces its width by 100ms.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await nextLayout();
  const cards = Array.from(document.querySelectorAll('[data-card]'));
  expect(cards).toHaveLength(ITEM_COUNT);
  return cards.map((card) => box(card.parentElement!));
}

describe('CosmeticShopSectionHomeBlock layout', () => {
  test('a wide screen shows all six cards in one row', async () => {
    const boxes = await cardBoxes(2130);
    expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(1);
    expect(new Set(boxes.map((b) => Math.round(b.left))).size).toBe(ITEM_COUNT);
  });

  test('when a row holds fewer cards, they fill it left to right before wrapping', async () => {
    // Room for four 336px columns.
    const boxes = await cardBoxes(1440);
    const [first, second] = boxes;
    expect(Math.round(second.top)).toBe(Math.round(first.top));
    expect(second.left).toBeGreaterThan(first.left);
  });

  test('below the md container width it stays a two-row carousel, filled by column', async () => {
    const boxes = await cardBoxes(900);
    const [first, second] = boxes;
    expect(Math.round(second.left)).toBe(Math.round(first.left));
    expect(second.top).toBeGreaterThan(first.top);
  });
});
