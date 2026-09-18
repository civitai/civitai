import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as BlocklistService from '~/server/services/blocklist.service';
import type * as BlurbMaterializeService from '~/server/services/blurb-materialize.service';

// The CosmeticShopItem half of the blurb save path, run against the REAL
// `upsertCosmeticShopItem` / `applyCosmeticShopItemContentChange`. Only the two blurb modules and
// the blocklist guard are stubbed; drop either blurb call and these fail.
//
// Hoisted: cosmetic-shop.service imports both modules, so these factories have to exist while this
// file's own imports are still resolving.
const { expandBlurbs, getReferencedBlurbIds, reconcileBlurbReferences, throwOnBlockedUserContent } =
  vi.hoisted(() => ({
    expandBlurbs: vi.fn(),
    getReferencedBlurbIds: vi.fn(),
    reconcileBlurbReferences: vi.fn(),
    throwOnBlockedUserContent: vi.fn(),
  }));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedUserContent,
}));
vi.mock('~/server/services/blurb-materialize.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlurbMaterializeService>()),
  expandBlurbs,
  getReferencedBlurbIds,
  reconcileBlurbReferences,
}));

import {
  applyCosmeticShopItemContentChange,
  upsertCosmeticShopItem,
} from '~/server/services/cosmetic-shop.service';

const ITEM_ID = 31;
const CREATED_ID = 32;
const OWNER_ID = 7;
const MODERATOR_ID = 9;
const STORED_PURCHASES = 12;

const CLIENT_HTML = '<div data-type="blurb" data-id="7">ATTACKER SUPPLIED</div>';
const EXPANDED_HTML = '<div data-type="blurb" data-id="7">REAL</div>';
const USES = [{ blurbId: 7, contentHash: 'h7' }];

const upsert = (input: Record<string, unknown> = {}) =>
  upsertCosmeticShopItem({
    id: ITEM_ID,
    userId: OWNER_ID,
    title: 'A title',
    description: CLIENT_HTML,
    unitAmount: 100,
    cosmeticId: 4,
    ...input,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  expandBlurbs.mockResolvedValue({ evaluated: true, html: EXPANDED_HTML, uses: USES });
  getReferencedBlurbIds.mockResolvedValue([7]);
  reconcileBlurbReferences.mockResolvedValue(undefined);
  throwOnBlockedUserContent.mockResolvedValue(undefined);
  dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({
    id: ITEM_ID,
    cosmeticId: 4,
    addedById: OWNER_ID,
    meta: { purchases: STORED_PURCHASES },
    _count: { purchases: 0 },
  });
  dbMock.dbWrite.cosmeticShopItem.update.mockResolvedValue({
    id: ITEM_ID,
    cosmeticId: null,
    meta: { purchases: STORED_PURCHASES },
    _count: { purchases: 20 },
  });
  dbMock.dbWrite.cosmeticShopItem.create.mockResolvedValue({
    id: CREATED_ID,
    cosmeticId: null,
    meta: { purchases: 0 },
    _count: { purchases: 0 },
  });
  dbMock.dbWrite.cosmeticShopItem.updateMany.mockResolvedValue({ count: 1 });
});

describe('upsertCosmeticShopItem — blurb expansion', () => {
  it('stores what the blurb says, not the html the client sent', async () => {
    await upsert();

    const { data } = dbMock.dbWrite.cosmeticShopItem.update.mock.calls[0][0];
    expect(data.description).toBe(EXPANDED_HTML);
    expect(data.description).not.toContain('ATTACKER SUPPLIED');
  });

  it('expands against the owner, not the moderator doing the saving', async () => {
    await upsert({ userId: MODERATOR_ID });

    // A moderator's own blurb set resolves none of the owner's `data-id`s, so every span would be
    // unwrapped to plain text — a silent, permanent loss of the item's blurbs.
    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ userId: OWNER_ID, html: CLIENT_HTML })
    );
  });

  it('resolves only the blurbs the item already references when a moderator saves', async () => {
    await upsert({ userId: MODERATOR_ID });

    // Handed over as a RESOLVER, not an awaited array. `expandBlurbs` owns the flag gate
    // and the has-spans check, so resolving the set before it is called reads
    // BlurbReference on saves where the feature is off or no blurb is named.
    const { restrictToBlurbIds } = expandBlurbs.mock.calls[0][0];
    expect(getReferencedBlurbIds).not.toHaveBeenCalled();

    expect(await restrictToBlurbIds()).toEqual([7]);
    expect(getReferencedBlurbIds).toHaveBeenCalledWith({
      entityType: 'CosmeticShopItem',
      entityId: ITEM_ID,
    });
  });

  it('leaves the owner unrestricted', async () => {
    await upsert();

    expect(getReferencedBlurbIds).not.toHaveBeenCalled();
    expect(expandBlurbs).toHaveBeenCalledWith(
      expect.objectContaining({ restrictToBlurbIds: undefined })
    );
  });

  it('stores the expanded html on a create too', async () => {
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue(null);

    await upsert({ id: undefined });

    expect(dbMock.dbWrite.cosmeticShopItem.create.mock.calls[0][0].data.description).toBe(
      EXPANDED_HTML
    );
  });
});

describe('upsertCosmeticShopItem — blurb reconciliation', () => {
  it('reconciles in the same transaction as the write, against the item id', async () => {
    await upsert();

    expect(reconcileBlurbReferences).toHaveBeenCalledWith({
      entityType: 'CosmeticShopItem',
      entityId: ITEM_ID,
      uses: USES,
      tx: expect.anything(),
    });

    const [write] = dbMock.dbWrite.cosmeticShopItem.update.mock.invocationCallOrder;
    const [reconcile] = reconcileBlurbReferences.mock.invocationCallOrder;
    expect(reconcile).toBeGreaterThan(write);
  });

  it('reconciles a new item against the id it was created with', async () => {
    dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue(null);

    await upsert({ id: undefined });

    expect(reconcileBlurbReferences).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: CREATED_ID })
    );
  });

  it('leaves an existing reference row alone when the flag is off for the owner', async () => {
    // Reconciling on an unevaluated expansion deletes EVERY reference row for the item, and the
    // fan-out — deliberately ungated so it can still maintain them — then has nothing left.
    expandBlurbs.mockResolvedValue({ evaluated: false, html: CLIENT_HTML });

    await upsert();

    expect(reconcileBlurbReferences).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.cosmeticShopItem.update).toHaveBeenCalled();
  });
});

describe('applyCosmeticShopItemContentChange', () => {
  it('writes the description column and nothing else', async () => {
    await applyCosmeticShopItemContentChange({ id: ITEM_ID, description: EXPANDED_HTML });

    // The fan-out calls this with nothing but new HTML. Route it back through the form-shaped
    // upsert and the failure mode is silent field loss — title, price, availability window and
    // quantity cleared on every item the job touches.
    const [call] = dbMock.dbWrite.cosmeticShopItem.updateMany.mock.calls;
    expect(call[0]).toEqual({ where: { id: ITEM_ID }, data: { description: EXPANDED_HTML } });
    expect(dbMock.dbWrite.cosmeticShopItem.update).not.toHaveBeenCalled();
  });

  it('rejects a blocked link domain before writing anything', async () => {
    throwOnBlockedUserContent.mockRejectedValue(new Error('invalid urls: blocked.example'));

    await expect(
      applyCosmeticShopItemContentChange({ id: ITEM_ID, description: EXPANDED_HTML })
    ).rejects.toThrow('invalid urls');

    expect(dbMock.dbWrite.cosmeticShopItem.updateMany).not.toHaveBeenCalled();
  });

  it('reports a missing item rather than silently doing nothing', async () => {
    dbMock.dbWrite.cosmeticShopItem.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      applyCosmeticShopItemContentChange({ id: ITEM_ID, description: EXPANDED_HTML })
    ).rejects.toThrow(/No cosmetic shop item/);
  });
});

/**
 * Reads now serve the purchase-row count in `meta.purchases`, and this form
 * seeds itself from a read and posts the whole meta object back. Without this
 * the editor writes a derived number into the stored counter on every save — of
 * a value that came from a React Query cache, so it can be older than the one it
 * replaces.
 *
 * TO WHOEVER IS ABOUT TO DELETE THIS: it is what keeps the sold-count change a
 * READ change. Only a purchase moves the stored counter.
 */
describe('upsertCosmeticShopItem — the stored purchase counter', () => {
  it('keeps the stored value when the client posts a different one', async () => {
    await upsert({ meta: { purchases: 99, acceptsBlueBuzz: true } });

    const { data } = dbMock.dbWrite.cosmeticShopItem.update.mock.calls[0][0];
    expect(data.meta.purchases).toBe(STORED_PURCHASES);
  });

  it('still saves the rest of the meta the moderator edited', async () => {
    await upsert({ meta: { purchases: 99, acceptsBlueBuzz: true } });

    const { data } = dbMock.dbWrite.cosmeticShopItem.update.mock.calls[0][0];
    expect(data.meta.acceptsBlueBuzz).toBe(true);
  });

  /**
   * The preservation above reads `existingItem.meta`, and the mock hands that
   * back whatever the fixture says regardless of what the select asked for — so
   * dropping `meta: true` from the select leaves all of this green while the
   * real read returns `undefined` and every save writes `purchases: 0`.
   *
   * TO WHOEVER IS ABOUT TO DELETE THIS: it is the only thing holding that one
   * word in the select, and without it the fix above is decorative.
   */
  it('asks the database for the stored meta it preserves', async () => {
    await upsert({ meta: { purchases: 99 } });

    expect(dbMock.dbWrite.cosmeticShopItem.findUnique.mock.calls[0][0].select.meta).toBe(true);
  });

  /**
   * The save's response is deliberately NOT passed through `withSoldCount`,
   * unlike every read path. Its only consumer invalidates the paged query and
   * discards the payload, so mapping it fixed nothing and pinned a value nobody
   * reads — which would have handed the next person a red test for correctly
   * deleting dead code.
   *
   * TO WHOEVER IS ABOUT TO ADD `withSoldCount` HERE FOR CONSISTENCY: that is the
   * decision this assertion exists to record, not an oversight. Without it the
   * line is unpinned in both directions and either choice passes.
   */
  it('hands back what it wrote, not a row-derived count', async () => {
    const saved = await upsert({ meta: { purchases: 99 } });

    expect(saved.meta.purchases).toBe(STORED_PURCHASES);
  });
});
