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
  // Owner checks read the primary, verdicts the replica: both see the same row here.
  dbMock.dbRead.cosmeticShopItem.findUnique.mockReset().mockImplementation(async () => stored);
  dbMock.dbWrite.cosmeticShopItem.findUnique.mockReset().mockImplementation(async () => stored);
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
    const before = Date.now();

    await reviewCreatorShopItem({
      reviewerId: MOD,
      id: 42,
      action: 'reject',
      stickersEnabled: false,
    });

    const written = storedMeta().withdrawnRefund!;
    expect(written).toEqual({
      trigger: 'reject',
      clawback: true,
      userId: MOD,
      at: expect.any(String),
    });
    // The cut-off for which purchases are owed: the verdict's own time.
    expect(Date.parse(written.at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(written.at)).toBeLessThanOrEqual(Date.now());
    expect(refund.refundWithdrawnShopItem.mock.calls).toEqual([[42, { limit: 25 }]]);
  });

  it('reject of a listing with no cosmetic of its own refunds nothing', async () => {
    stored = { ...listing('Published', { displayApproved: true }), cosmeticId: null };

    await reviewCreatorShopItem({
      reviewerId: MOD,
      id: 42,
      action: 'reject',
      stickersEnabled: false,
    });

    expect(storedMeta().withdrawnRefund).toBeUndefined();
    expect(refund.refundWithdrawnShopItem).not.toHaveBeenCalled();
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
  const history = (...entries: { kind: string; action?: string; field?: string }[]) =>
    entries.map(({ kind, action, field }, i) => ({
      at: `2026-10-0${i + 1}T00:00:00.000Z`,
      userId: kind === 'reviewed' ? MOD : CREATOR,
      kind,
      ...(action ? { action } : {}),
      ...(field ? { changes: [{ field, from: 'a', to: 'b' }] } : {}),
    })) as CosmeticShopItemMeta['history'];

  // Archiving is the creator's own act, so the creator pays whatever withheld the item
  // (Justin, 2026-10-20), including an item a moderator sent back.
  it.each([
    [
      'a moderator sent it back after approval',
      history(
        { kind: 'submitted' },
        { kind: 'reviewed', action: 'approve' },
        { kind: 'reviewed', action: 'request-changes' }
      ),
    ],
    [
      'its creator edited what holders see after approval',
      history(
        { kind: 'submitted' },
        { kind: 'reviewed', action: 'approve' },
        { kind: 'edited', field: 'artwork' }
      ),
    ],
    [
      'a moderator sent it back before it was ever approved',
      history({ kind: 'submitted' }, { kind: 'reviewed', action: 'request-changes' }),
    ],
    ['nothing records who withheld it', undefined],
  ])('an item withheld because %s refunds its buyers and reverses the payouts', async (_, h) => {
    stored = listing('RequestedChanges', { displayApproved: false, ...(h ? { history: h } : {}) });
    const before = Date.now();

    await archiveCreatorShopItem({ userId: CREATOR, id: 42 });

    const written = storedMeta().withdrawnRefund!;
    expect(written).toEqual({
      trigger: 'archive',
      clawback: true,
      userId: CREATOR,
      at: expect.any(String),
    });
    expect(Date.parse(written.at)).toBeGreaterThanOrEqual(before);
    expect(refund.refundWithdrawnShopItem.mock.calls).toEqual([[42, { limit: 25 }]]);
  });

  it('a withheld listing with no cosmetic of its own refunds nothing', async () => {
    stored = { ...listing('RequestedChanges', { displayApproved: false }), cosmeticId: null };

    await archiveCreatorShopItem({ userId: CREATOR, id: 42 });

    expect(storedMeta().withdrawnRefund).toBeUndefined();
    expect(refund.refundWithdrawnShopItem).not.toHaveBeenCalled();
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
