import { describe, expect, it, vi } from 'vitest';
import type { PlaceAllItem } from '~/components/Sticker/place-all';
import { placeAllPlan, runPlaceAll } from '~/components/Sticker/place-all';
import type { CreateStickerPlacementInput } from '~/server/schema/placement.schema';

const input = (cosmeticId: number) =>
  ({
    imageId: 1,
    free: false,
    data: { cosmeticId, x: 0.5, y: 0.5, scale: 0.2, rotation: 0, flip: false, opacity: 1 },
  } as CreateStickerPlacementInput);
const ready = (free: boolean) => ({ free, input: () => input(1) });

describe('placeAllPlan', () => {
  it('charges only the paid drafts that are ready, in creation order', () => {
    const plan = placeAllPlan({
      drafts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      // c still needs a use bought, so it is not ready and must not be charged for.
      ready: { d: ready(false), a: ready(true), b: ready(false) },
      price: 5,
    });

    expect(plan).toEqual({ queue: ['a', 'b', 'd'], paid: 2, total: 10 });
  });
});

describe('runPlaceAll', () => {
  const items: PlaceAllItem[] = ['a', 'b', 'c'].map((draftId, i) => ({
    draftId,
    input: input(i + 1),
  }));

  it('places each in turn and counts the ones left pending', async () => {
    const place = vi
      .fn()
      .mockResolvedValueOnce({ status: 'approved' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'approved' });
    const onPlaced = vi.fn();

    const result = await runPlaceAll(items, place, onPlaced, () => true);

    expect(place.mock.calls.map(([sent]) => sent.data.cosmeticId)).toEqual([1, 2, 3]);
    expect(onPlaced.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
    expect(result).toEqual({ placed: 3, pending: 1, skipped: 0, failed: null });
  });

  it('stops at the first refusal: earlier ones stay placed, later ones are never sent', async () => {
    const refusal = new Error('placement: you already have the maximum pending placements');
    const place = vi
      .fn()
      .mockResolvedValueOnce({ status: 'approved' })
      .mockRejectedValueOnce(refusal)
      .mockResolvedValueOnce({ status: 'approved' });
    const onPlaced = vi.fn();

    const result = await runPlaceAll(items, place, onPlaced, () => true);

    expect(place).toHaveBeenCalledTimes(2);
    expect(onPlaced.mock.calls.map(([id]) => id)).toEqual(['a']);
    expect(result).toEqual({
      placed: 1,
      pending: 0,
      skipped: 0,
      failed: { draftId: 'b', error: refusal },
    });
  });

  it('skips a draft removed during the run, and charges nothing for it', async () => {
    const place = vi.fn().mockResolvedValue({ status: 'approved' });
    const onPlaced = vi.fn();

    const result = await runPlaceAll(items, place, onPlaced, (id) => id !== 'b');

    expect(place.mock.calls.map(([sent]) => sent.data.cosmeticId)).toEqual([1, 3]);
    expect(result).toEqual({ placed: 2, pending: 0, skipped: 1, failed: null });
  });
});
