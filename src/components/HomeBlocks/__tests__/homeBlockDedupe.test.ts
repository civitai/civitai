import { describe, expect, it } from 'vitest';
import {
  claimedBelow,
  claimKey,
  dedupeOrder,
  selectDedupedItems,
} from '~/components/HomeBlocks/homeBlockDedupe';

const item = (id: number, userId = id) => ({ id, user: { id: userId } });
const takenSet = (entity: string, ids: number[]) => new Set(ids.map((id) => claimKey(entity, id)));

describe('dedupeOrder', () => {
  it('orders blocks by render position, and sub-lists within a block', () => {
    expect(dedupeOrder(1)).toBeLessThan(dedupeOrder(2));
    expect(dedupeOrder(7, 0)).toBeLessThan(dedupeOrder(7, 1));
    expect(dedupeOrder(7, 999)).toBeLessThan(dedupeOrder(8));
  });

  it('clamps a runaway subIndex rather than colliding with the next block', () => {
    // Two blocks sharing an order would silently overwrite each other's claims, so the last
    // sub-list slot saturates instead.
    expect(dedupeOrder(7, 5000)).toBeLessThan(dedupeOrder(8));
    expect(dedupeOrder(7, 5000)).toEqual(dedupeOrder(7, 999));
  });
});

describe('selectDedupedItems', () => {
  it('drops what an earlier block claimed and backfills from the overfetch', () => {
    const out = selectDedupedItems(
      [1, 2, 3, 4, 5].map((id) => item(id)),
      {
        taken: takenSet('image', [1, 2]),
        entity: 'image',
        itemsToShow: 3,
      }
    );
    expect(out.map((x) => x.id)).toEqual([3, 4, 5]);
  });

  it('does not suppress an id claimed under a different entity', () => {
    // Guards the entity segment in the key. Written so it fails if the key were just the id:
    // ids 1 and 2 are claimed as models, and this block would come back [3] without them.
    const out = selectDedupedItems(
      [1, 2, 3].map((id) => item(id)),
      {
        taken: takenSet('model', [1, 2]),
        entity: 'image',
        itemsToShow: 2,
      }
    );
    expect(out.map((x) => x.id)).toEqual([1, 2]);
  });

  it('readmits duplicates behind unclaimed items rather than rendering a short row', () => {
    const out = selectDedupedItems(
      [1, 2, 3, 4].map((id) => item(id)),
      {
        taken: takenSet('image', [1, 2, 3]),
        entity: 'image',
        itemsToShow: 3,
      }
    );
    // 4 is the only unclaimed item, so it leads and two duplicates fill the row behind it.
    expect(out[0].id).toEqual(4);
    expect(out).toHaveLength(3);
  });

  it('prefers unclaimed items over claimed ones when it cannot fill either way', () => {
    const out = selectDedupedItems([item(1), item(2), item(3), item(4)], {
      taken: takenSet('image', [1, 2]),
      entity: 'image',
      itemsToShow: 3,
    });
    expect(out.slice(0, 2).map((x) => x.id)).toEqual([3, 4]);
    expect([1, 2]).toContain(out[2].id);
  });

  it('counts readmitted duplicates against maxPerUser, so a short row is still possible', () => {
    // The documented limit of the backfill: creator 10 is capped at 1, so its duplicate cannot
    // fill the third slot even though an item exists for it.
    const out = selectDedupedItems([item(1, 10), item(2, 10), item(3, 20)], {
      taken: takenSet('image', [1, 2]),
      entity: 'image',
      itemsToShow: 3,
      maxPerUser: 1,
    });
    expect(out.map((x) => x.id)).toEqual([3, 1]);
  });

  it('is a no-op when nothing has been claimed', () => {
    const out = selectDedupedItems(
      [1, 2, 3, 4].map((id) => item(id)),
      {
        taken: new Set<string>(),
        entity: 'image',
        itemsToShow: 3,
      }
    );
    expect(out.map((x) => x.id)).toEqual([1, 2, 3]);
  });
});

describe('claimedBelow', () => {
  const claims = {
    [dedupeOrder(0)]: ['image:1'],
    [dedupeOrder(1)]: ['image:2'],
    [dedupeOrder(2)]: ['image:3'],
  };

  it('reads only the orders ahead of the block', () => {
    expect(claimedBelow(claims, dedupeOrder(1))).toEqual(['image:1']);
  });

  it('excludes the block’s own order, which would let it consume its own claim', () => {
    expect(claimedBelow(claims, dedupeOrder(0))).toEqual([]);
  });

  it('accumulates every earlier order, not just the previous one', () => {
    expect(claimedBelow(claims, dedupeOrder(2)).sort()).toEqual(['image:1', 'image:2']);
  });
});
