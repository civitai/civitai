// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzButtonModule from '~/components/Buzz/BuzzTransactionButton';
import type * as CosmeticShopUtil from '~/components/CosmeticShop/cosmetic-shop.util';
import type * as CosmeticsUtil from '~/components/Cosmetics/cosmetics.util';
import type * as CosmeticPreviewModule from '~/components/CosmeticShop/CosmeticPreview';
import type * as CosmeticSampleModule from '~/components/Shop/CosmeticSample';
import type { CosmeticShopItemGetById } from '~/types/router';
import { CosmeticType } from '~/shared/utils/prisma/enums';

const act = (React as unknown as { act: typeof actType }).act;

const COSMETIC_ID = 31;
let ownedIds: number[] = [];
let balances: { cosmeticId: number; remaining: number | null }[] = [];

vi.mock('~/components/Cosmetics/cosmetics.util', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticsUtil>()),
  useQueryUserCosmetics: () => ({
    data: { sticker: ownedIds.map((id) => ({ id })), badges: ownedIds.map((id) => ({ id })) },
    isLoading: false,
  }),
  useQueryStickerBalances: () => ({ data: balances, isLoading: false }),
  useEquipProfileDecoration: () => ({ equip: vi.fn(), isLoading: false }),
}));
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopUtil>()),
  useMutateCosmeticShop: () => ({ purchaseShopItem: vi.fn(), purchasingShopItem: false }),
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));
vi.mock('~/components/Buzz/BuzzTransactionButton', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzButtonModule>()),
  BuzzTransactionButton: ({ label }: { label: string }) =>
    React.createElement('button', { 'data-buy': true }, label),
}));
vi.mock('~/components/CosmeticShop/CosmeticPreview', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticPreviewModule>()),
  CosmeticPreview: () => null,
}));
vi.mock('~/components/Shop/CosmeticSample', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticSampleModule>()),
  CosmeticSample: () => null,
}));

const { CosmeticShopItemPreviewModal } = await import(
  '~/components/CosmeticShop/CosmeticShopItemPreviewModal'
);

const shopItem = (type: CosmeticType) =>
  ({
    id: 1,
    title: 'An item',
    unitAmount: 175,
    availableQuantity: null,
    availableFrom: null,
    availableTo: null,
    meta: {},
    cosmetic: {
      id: COSMETIC_ID,
      name: 'An item',
      type,
      data: { uses: 35 },
      creator: { id: 5 },
    },
  } as unknown as CosmeticShopItemGetById);

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const hasPurchaseButton = async (type: CosmeticType) => {
  await act(async () => {
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CosmeticShopItemPreviewModal, { shopItem: shopItem(type) })
      )
    );
  });
  return !!document.querySelector('button[data-buy]');
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  ownedIds = [];
  balances = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

describe('CosmeticShopItemPreviewModal purchase button', () => {
  it('sells another batch of a sticker whose held uses are spent', async () => {
    ownedIds = [COSMETIC_ID];
    balances = [{ cosmeticId: COSMETIC_ID, remaining: 0 }];
    expect(await hasPurchaseButton(CosmeticType.Sticker)).toBe(true);
  });

  it('hides it for a sticker held with unlimited uses', async () => {
    ownedIds = [COSMETIC_ID];
    balances = [{ cosmeticId: COSMETIC_ID, remaining: null }];
    expect(await hasPurchaseButton(CosmeticType.Sticker)).toBe(false);
    expect(document.body.textContent).toContain('You already own this sticker');
  });

  it('reads the balance of this sticker, not another one', async () => {
    ownedIds = [COSMETIC_ID];
    balances = [
      { cosmeticId: 999, remaining: 0 },
      { cosmeticId: COSMETIC_ID, remaining: null },
    ];
    expect(await hasPurchaseButton(CosmeticType.Sticker)).toBe(false);
  });

  it('hides it for a badge already held', async () => {
    ownedIds = [COSMETIC_ID];
    expect(await hasPurchaseButton(CosmeticType.Badge)).toBe(false);
  });
});
