import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type * as NotificationService from '~/server/services/notification.service';

const refund = vi.hoisted(() => ({ refundWithdrawnShopItem: vi.fn() }));
vi.mock('~/server/services/creator-shop-withdrawn-refund.service', () => refund);
vi.mock('~/server/services/notification.service', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationService>()),
  createNotification: vi.fn(),
}));

const { archiveCreatorShopItem, reviewCreatorShopItem, unarchiveCreatorShopItem } = await import(
  '~/server/services/creator-shop.service'
);

const CREATOR = 11;
const MOD = 99;
const COSMETIC = 7;
const marker = { trigger: 'reject', clawback: true, userId: MOD, at: '2026-10-01T00:00:00.000Z' };

const listing = (status: string, meta: Partial<CosmeticShopItemMeta>) => ({
  id: 42,
  cosmeticId: COSMETIC as number | null,
  addedById: CREATOR,
  status,
  rejectionReason: null,
  unitAmount: 500,
  title: 'Gilded Aurora',
  description: null,
  availableQuantity: null,
  itemDefinitionId: null,
  itemDefinition: null,
  meta: { purchases: 0, ...meta },
  cosmetic: {
    id: COSMETIC,
    createdById: CREATOR,
    type: 'ProfileDecoration',
    data: { url: 'art' },
    creator: { username: 'creator' },
  },
  _count: { purchases: 3 },
});
let stored: ReturnType<typeof listing>;
const storedMeta = () => stored.meta as CosmeticShopItemMeta;

beforeEach(() => {
  refund.refundWithdrawnShopItem.mockReset().mockResolvedValue({ purchases: 0 });
  dbMock.dbRead.cosmeticShopItem.findUnique.mockReset().mockImplementation(async () => stored);
  dbMock.dbWrite.cosmeticShopItem.update
    .mockReset()
    .mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      stored = { ...stored, ...data } as typeof stored;
      return stored;
    });
});

describe('a verdict', () => {
  it('reject marks the item for a refund with clawback and starts it', async () => {
    stored = listing('Published', { displayApproved: true });

    await reviewCreatorShopItem({
      reviewerId: MOD,
      id: 42,
      action: 'reject',
      stickersEnabled: false,
    });

    expect(storedMeta().withdrawnRefund).toEqual({
      trigger: 'reject',
      clawback: true,
      userId: MOD,
      at: expect.any(String),
    });
    expect(refund.refundWithdrawnShopItem).toHaveBeenCalledWith(42);
  });

  it.each(['approve', 'request-changes', 'revert'] as const)(
    '%s refunds nothing and ends a refund a rejection left unfinished',
    async (action) => {
      stored = listing(action === 'revert' ? 'Published' : 'Rejected', {
        withdrawnRefund: marker as never,
      });

      await reviewCreatorShopItem({ reviewerId: MOD, id: 42, action, stickersEnabled: false });

      expect(storedMeta().withdrawnRefund).toBeUndefined();
      expect(refund.refundWithdrawnShopItem).not.toHaveBeenCalled();
    }
  );

  it('a refund that throws does not fail the verdict', async () => {
    stored = listing('Published', { displayApproved: true });
    refund.refundWithdrawnShopItem.mockRejectedValue(new Error('redis down'));

    await expect(
      reviewCreatorShopItem({ reviewerId: MOD, id: 42, action: 'reject', stickersEnabled: false })
    ).resolves.toMatchObject({ status: 'Rejected' });
  });
});

describe('archiving', () => {
  it('a withheld item refunds its buyers, the platform paying', async () => {
    stored = listing('RequestedChanges', { displayApproved: false });

    await archiveCreatorShopItem({ userId: CREATOR, id: 42 });

    expect(storedMeta().withdrawnRefund).toEqual({
      trigger: 'archive',
      clawback: false,
      userId: CREATOR,
      at: expect.any(String),
    });
    expect(refund.refundWithdrawnShopItem).toHaveBeenCalledWith(42);
  });

  it.each([
    ['live', 'Published', {}],
    ['approved and back in review unchanged', 'PendingReview', { displayApproved: true }],
  ])('a %s item refunds nothing', async (_, status, meta) => {
    stored = listing(status, meta);

    await archiveCreatorShopItem({ userId: CREATOR, id: 42 });

    expect(storedMeta().withdrawnRefund).toBeUndefined();
    expect(refund.refundWithdrawnShopItem).not.toHaveBeenCalled();
  });

  it('restoring ends the refund the archive started', async () => {
    stored = listing('Archived', {
      displayApproved: false,
      withdrawnRefund: { ...marker, trigger: 'archive', clawback: false } as never,
    });

    await unarchiveCreatorShopItem({ userId: CREATOR, id: 42 });

    expect(storedMeta().withdrawnRefund).toBeUndefined();
    expect(stored.status).toBe('PendingReview');
  });
});
