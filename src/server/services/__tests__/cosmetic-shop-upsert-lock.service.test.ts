/**
 * The moderator cosmetic-store editor saves a whole form, `meta` included, loaded some time before.
 * It must build `meta` from the row read under its lock and record what it changed, so it neither
 * erases a creator edit, verdict or refund entry committed since nor changes a creator listing's
 * price or text without moving the version a pending verdict is pinned to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BlurbMaterializeService from '~/server/services/blurb-materialize.service';

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blurb-materialize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlurbMaterializeService>()),
  expandBlurbs: vi.fn(async ({ html }: { html: string }) => ({ evaluated: false, html, uses: [] })),
  getReferencedBlurbIds: vi.fn(async () => []),
  reconcileBlurbReferences: vi.fn(async () => undefined),
}));

import { upsertCosmeticShopItem } from '~/server/services/cosmetic-shop.service';
import { shopItemReviewVersion } from '~/server/services/creator-shop.data';

const submitted = { at: '2026-10-01T00:00:00.000Z', userId: 11, kind: 'submitted' };
const artSwapped = {
  at: '2026-10-03T00:00:00.000Z',
  userId: 11,
  kind: 'edited',
  changes: [{ field: 'artwork', from: 'old-art', to: 'new-art' }],
};
const loadedMeta = { purchases: 2, displayApproved: true, history: [submitted] };
const lockedRow = {
  status: 'PendingReview',
  unitAmount: 500,
  rejectionReason: null,
  title: 'Golden Laurel',
  description: null,
  availableQuantity: null,
  meta: {
    purchases: 3,
    displayApproved: false,
    imageHash: 'new',
    history: [submitted, artSwapped],
  },
};

let locked = false;
const lockedRead = vi.fn(async () => {
  if (!locked) throw new Error('read the row before locking it');
  return lockedRow;
});
const update = dbMock.dbWrite.cosmeticShopItem.update;
const writtenMeta = () =>
  (update.mock.calls.at(-1)?.[0] as { data: { meta?: Record<string, unknown> } }).data.meta;

const save = (input: Record<string, unknown> = {}) =>
  upsertCosmeticShopItem({
    id: 42,
    userId: 99,
    isModerator: true,
    title: 'Golden Laurel',
    unitAmount: 500,
    cosmeticId: 7,
    meta: loadedMeta,
    ...input,
  } as never);

beforeEach(() => {
  locked = false;
  lockedRead.mockClear();
  update.mockReset();
  update.mockResolvedValue({ id: 42, cosmeticId: 7, meta: {}, _count: { purchases: 3 } } as never);
  dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({
    id: 42,
    cosmeticId: 7,
    addedById: 11,
    _count: { purchases: 3 },
  } as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
    fn({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('?').includes('FOR NO KEY UPDATE') && values[0] === 42) locked = true;
        return [];
      },
      cosmeticShopItem: { findUnique: lockedRead, update },
    })) as never);
});

describe('saving a creator listing from the cosmetic-store editor', () => {
  it('keeps what was committed after the form loaded', async () => {
    await save();
    expect(writtenMeta()).toMatchObject({
      purchases: 3,
      displayApproved: false,
      imageHash: 'new',
      history: [{ kind: 'submitted' }, { kind: 'edited' }],
    });
  });

  it('records a price change, moving the version a pending verdict is pinned to', async () => {
    await save({ unitAmount: 900 });
    const meta = writtenMeta() as { history?: { kind: string; changes?: unknown[] }[] };
    expect(meta.history?.at(-1)).toMatchObject({
      kind: 'edited',
      userId: 99,
      changes: [{ field: 'price', from: 500, to: 900 }],
    });
    expect(shopItemReviewVersion(meta as never)).not.toBe(
      shopItemReviewVersion(lockedRow.meta as never)
    );
  });
});
