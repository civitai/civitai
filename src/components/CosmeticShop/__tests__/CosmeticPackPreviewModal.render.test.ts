// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import type { act as actType } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BuzzButtonModule from '~/components/Buzz/BuzzTransactionButton';
import type * as CosmeticShopUtil from '~/components/CosmeticShop/cosmetic-shop.util';
import type * as TrpcModule from '~/utils/trpc';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The modal fed what `getPackDetail` really returns for a pack whose member
 * Cosmetics were deleted: the join rows cascade away with them, and only
 * `meta.packMemberCount` still says what the pack was sold as. The server
 * refuses that purchase, so the button must not render priced and enabled.
 */

const act = (React as unknown as { act: typeof actType }).act;

const shopItemFindUnique = dbMock.dbRead.cosmeticShopItem.findUnique;
const shopItemFindMany = dbMock.dbRead.cosmeticShopItem.findMany;
let packDetail: unknown;
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    creatorShop: { getPack: { useQuery: () => ({ data: packDetail, isLoading: false }) } },
  },
}));
vi.mock('~/components/CosmeticShop/cosmetic-shop.util', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticShopUtil>()),
  useMutateCosmeticShop: () => ({ purchaseShopItem: vi.fn(), purchasingShopItem: false }),
}));
vi.mock('~/components/Buzz/useAvailableBuzz', () => ({ useAvailableBuzz: () => ['yellow'] }));
vi.mock('~/components/Dialog/DialogProvider', () => ({
  useDialogContext: () => ({ opened: true, onClose: vi.fn() }),
}));
// Its own balance and session reads are not what is under test; whether the
// modal hands it `disabled` is.
vi.mock('~/components/Buzz/BuzzTransactionButton', async (importOriginal) => ({
  ...(await importOriginal<typeof BuzzButtonModule>()),
  BuzzTransactionButton: ({ disabled, label }: { disabled?: boolean; label: string }) =>
    React.createElement('button', { disabled, 'data-buy': true }, label),
}));

const { getPackDetail } = await import('~/server/services/creator-shop-pack.service');
const { CosmeticPackPreviewModal } = await import(
  '~/components/CosmeticShop/CosmeticPackPreviewModal'
);

const PACK_ID = 6001;
const LISTER = 701;
const BUYER = 702;
const builtWith = [
  { cosmeticId: 4001, floorAmount: 2600 },
  { cosmeticId: 4002, floorAmount: 3100 },
];

const packWithSurvivors = (survivors: typeof builtWith) => {
  shopItemFindUnique.mockResolvedValue({
    id: PACK_ID,
    cosmeticId: null,
    title: 'A pack',
    description: null,
    unitAmount: 8800,
    status: CosmeticShopItemStatus.Published,
    listed: true,
    availableQuantity: null,
    meta: { purchases: 0, packMemberCount: builtWith.length },
    addedById: LISTER,
    members: survivors,
    _count: { purchases: 0 },
  });
  shopItemFindMany.mockResolvedValue(
    survivors.map((m) => ({
      cosmeticId: m.cosmeticId,
      unitAmount: m.floorAmount,
      meta: {},
      cosmetic: {
        id: m.cosmeticId,
        name: `Badge ${m.cosmeticId}`,
        type: CosmeticType.Badge,
        data: { url: 'img' },
        createdById: 703,
        creator: { username: 'other' },
      },
    }))
  );
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const renderModal = async () => {
  packDetail = await getPackDetail({ shopItemId: PACK_ID, userId: BUYER });
  await act(async () => {
    root.render(
      React.createElement(
        MantineProvider,
        null,
        React.createElement(CosmeticPackPreviewModal, { shopItemId: PACK_ID })
      )
    );
  });
  const button = document.querySelector<HTMLButtonElement>('button[data-buy]');
  if (!button) throw new Error('Buy button did not render');
  return button;
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

describe('CosmeticPackPreviewModal on a pack that lost members', () => {
  it.each([
    { name: 'every member', survivors: [] },
    { name: 'one member', survivors: builtWith.slice(1) },
  ])('disables Buy, with a reason, when $name was deleted', async ({ survivors }) => {
    packWithSurvivors(survivors);
    const button = await renderModal();
    expect(button.disabled).toBe(true);
    expect(document.body.textContent).toContain('Something in this pack is no longer for sale');
  });

  it('leaves Buy enabled, with no such reason, on a whole pack', async () => {
    packWithSurvivors(builtWith);
    const button = await renderModal();
    expect(button.disabled).toBe(false);
    expect(document.body.textContent).not.toContain('no longer for sale');
  });
});
