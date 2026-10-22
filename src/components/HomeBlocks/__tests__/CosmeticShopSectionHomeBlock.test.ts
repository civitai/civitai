// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';

// The block's body is shared by every viewer, so a viewer's blocks are applied here and nowhere
// else. These pin the two halves of that: nothing renders before the viewer's blocks are known,
// and once they are, a blocked seller's item is dropped and the row is filled from behind.

const { prefs, homeBlock } = vi.hoisted(() => ({
  prefs: { blockRelations: new Map<number, boolean>(), hiddenLoading: false },
  homeBlock: { data: undefined as unknown },
}));

vi.mock('~/components/HiddenPreferences/HiddenPreferencesProvider', () => ({
  useHiddenPreferencesContext: () => prefs,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({
    'homeBlock.getHomeBlock': { useQuery: () => ({ data: homeBlock.data }) },
  }),
}));
vi.mock('~/components/Shop/ShopItem', () => ({
  ShopItem: ({ item }: { item: { id: number } }) =>
    createElement('div', { 'data-shop-item': item.id }),
}));
vi.mock('~/components/HomeBlocks/components/HomeBlockHeaderMeta', () => ({
  HomeBlockHeaderMeta: () => null,
}));
vi.mock('~/components/HomeBlocks/HomeBlockWrapper', () => ({
  HomeBlockWrapper: ({ children }: { children: unknown }) => children,
}));
vi.mock('~/server/schema/cosmetic-shop.schema', () => ({ CIVITAI_SHOP_ATTRIBUTION: -1 }));

import { CosmeticShopSectionHomeBlock } from '~/components/HomeBlocks/CosmeticShopSectionHomeBlock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const item = (id: number, creatorId: number) => ({
  createdAt: new Date(),
  shopItem: { id, addedById: 999, cosmetic: { creator: { id: creatorId } }, addedBy: null },
});

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function render() {
  homeBlock.data = {
    cosmeticShopSection: {
      title: 'Halloween',
      items: [item(1, 50), item(2, 60), item(3, 61), item(4, 62)],
    },
  };
  container = document.createElement('div');
  root = createRoot(container);
  act(() => {
    root.render(
      createElement(CosmeticShopSectionHomeBlock, {
        homeBlockId: 40,
        metadata: { cosmeticShopSection: { id: 9, maxItems: 2 } },
      })
    );
  });
  return [...container.querySelectorAll('[data-shop-item]')].map((el) =>
    Number(el.getAttribute('data-shop-item'))
  );
}

afterEach(() => act(() => root.unmount()));

describe('CosmeticShopSectionHomeBlock', () => {
  it('renders nothing until the viewer’s blocks have loaded', () => {
    prefs.blockRelations = new Map();
    prefs.hiddenLoading = true;

    expect(render()).toEqual([]);
  });

  it('drops a blocked seller’s item once they have, filling the row from the items behind', () => {
    prefs.blockRelations = new Map([[50, true]]);
    prefs.hiddenLoading = false;

    expect(render()).toEqual([2, 3]);
  });
});
