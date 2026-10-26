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

let items: Array<{ createdAt: Date; shopItem: Record<string, unknown> }> = [];
const makeItems = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
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

type Meta = { id: number; maxItems?: number; random?: boolean };

async function cardBoxes(width: number, { count, meta }: { count: number; meta: Meta }) {
  items = makeItems(count);
  await renderAtViewport(
    // The home page's FeedLayout provider, without its ad unit.
    <MasonryProvider columnWidth={constants.cardSizes.model} className="z-10 m-0 flex-1">
      <CosmeticShopSectionHomeBlock homeBlockId={1} metadata={{ cosmeticShopSection: meta }} />
    </MasonryProvider>,
    { width, height: 1000 }
  );
  // MasonryProvider debounces its width by 100ms.
  await new Promise((resolve) => setTimeout(resolve, 300));
  await nextLayout();
  // Cards past the grid's two rows are rendered but clipped by its overflow, so they are not seen.
  const cards = Array.from(document.querySelectorAll('[data-card]'));
  const grid = box(cards[0].parentElement!.parentElement!);
  return cards.map((card) => box(card.parentElement!)).filter((b) => b.bottom <= grid.bottom + 1);
}

const rounded = (values: number[]) => values.map((v) => Math.round(v));
const rowOf = <T extends { top: number }>(boxes: T[], top: number) =>
  boxes.filter((b) => Math.round(b.top) === Math.round(top));

const ITEM_COUNT = 6;
const sixItems = { count: ITEM_COUNT, meta: { id: 1, maxItems: ITEM_COUNT } };
// A rotating block names no maxItems, so the shared default decides how many cards it shows.
const rotating = { count: 20, meta: { id: 1, random: true } };

describe('CosmeticShopSectionHomeBlock layout', () => {
  test('a wide screen shows all six cards in one row', async () => {
    const boxes = await cardBoxes(2130, sixItems);
    expect(boxes).toHaveLength(ITEM_COUNT);
    expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(1);
    expect(new Set(boxes.map((b) => Math.round(b.left))).size).toBe(ITEM_COUNT);
  });

  test('when a row holds fewer cards, they fill it left to right before wrapping', async () => {
    // Room for four 336px columns.
    const boxes = await cardBoxes(1440, sixItems);
    const [first, second] = boxes;
    expect(Math.round(second.top)).toBe(Math.round(first.top));
    expect(second.left).toBeGreaterThan(first.left);
  });

  test('below the md container width it stays a two-row carousel, filled by column', async () => {
    const boxes = await cardBoxes(900, sixItems);
    const [first, second] = boxes;
    expect(Math.round(second.left)).toBe(Math.round(first.left));
    expect(second.top).toBeGreaterThan(first.top);
  });

  test('the one-row carousel below sm shows every card', async () => {
    const boxes = await cardBoxes(500, rotating);
    expect(boxes).toHaveLength(14);
    expect(new Set(boxes.map((b) => Math.round(b.top))).size).toBe(1);
  });

  // Columns the grid fits: viewport -> columns, measured here, not estimated.
  test.each([
    [1280, 3],
    [1440, 4],
    [1920, 5],
    [2130, 6],
    [2560, 7],
  ])(
    'a rotating block fills every slot of its two rows at %ipx (%i columns)',
    async (width, columns) => {
      const boxes = await cardBoxes(width, rotating);
      expect(boxes).toHaveLength(columns * 2);
      const firstRow = rowOf(boxes, boxes[0].top);
      expect(firstRow).toHaveLength(columns);
      expect(new Set(rounded(firstRow.map((b) => b.left))).size).toBe(columns);
    }
  );
});
