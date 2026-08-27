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
const { expandBlurbs, getReferencedBlurbIds, reconcileBlurbReferences, throwOnBlockedLinkDomain } =
  vi.hoisted(() => ({
    expandBlurbs: vi.fn(),
    getReferencedBlurbIds: vi.fn(),
    reconcileBlurbReferences: vi.fn(),
    throwOnBlockedLinkDomain: vi.fn(),
  }));

vi.mock('~/server/services/blocklist.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BlocklistService>()),
  throwOnBlockedLinkDomain,
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
  throwOnBlockedLinkDomain.mockResolvedValue(undefined);
  dbMock.dbWrite.cosmeticShopItem.findUnique.mockResolvedValue({
    id: ITEM_ID,
    cosmeticId: 4,
    addedById: OWNER_ID,
    _count: { purchases: 0 },
  });
  dbMock.dbWrite.cosmeticShopItem.update.mockResolvedValue({ id: ITEM_ID, cosmeticId: null });
  dbMock.dbWrite.cosmeticShopItem.create.mockResolvedValue({ id: CREATED_ID, cosmeticId: null });
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

    expect(getReferencedBlurbIds).toHaveBeenCalledWith({
      entityType: 'CosmeticShopItem',
      entityId: ITEM_ID,
    });
    expect(expandBlurbs).toHaveBeenCalledWith(expect.objectContaining({ restrictToBlurbIds: [7] }));
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
  it('reconciles after the write, against the item id', async () => {
    await upsert();

    expect(reconcileBlurbReferences).toHaveBeenCalledWith({
      entityType: 'CosmeticShopItem',
      entityId: ITEM_ID,
      uses: USES,
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
    throwOnBlockedLinkDomain.mockRejectedValue(new Error('invalid urls: blocked.example'));

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
