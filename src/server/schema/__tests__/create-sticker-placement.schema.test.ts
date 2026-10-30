import { describe, expect, it } from 'vitest';
import { createStickerPlacementSchema } from '~/server/schema/placement.schema';

const data = { cosmeticId: 85, x: 0.25, y: 0.75, scale: 0.2, rotation: 15 };

describe('the free flag selects a path and asserts nothing', () => {
  it('defaults to paid, so a client cached from before the free tier still places', () => {
    expect(createStickerPlacementSchema.parse({ imageId: 74, data })).toMatchObject({
      free: false,
    });
  });

  it('accepts an explicit choice either way', () => {
    expect(createStickerPlacementSchema.parse({ imageId: 74, data, free: true }).free).toBe(true);
    expect(createStickerPlacementSchema.parse({ imageId: 74, data, free: false }).free).toBe(false);
  });
});

/**
 * 🔴 The one field this input must never carry.
 *
 * `createFreePlacement` takes `placerId` as a plain number and cannot tell where
 * it came from, and every free-tier rule — the daily allowance,
 * never-twice-here, the block and suspension checks — is a statement *about*
 * that id rather than a check *of* it. So nothing downstream notices a wrong
 * one: it would spend somebody else's allowance, place under their name, and
 * have the never-twice rule protect the wrong account.
 *
 * The router reads it from the session, and this is the second lock on the same
 * door: zod strips what it does not declare, so a `placerId` on the wire cannot
 * survive parsing even if a future spread order stopped overwriting it.
 */
describe('the placer cannot come from the request body', () => {
  it('strips a client-supplied placerId rather than carrying it', () => {
    const parsed = createStickerPlacementSchema.parse({ imageId: 74, data, placerId: 999 });

    expect(parsed).not.toHaveProperty('placerId');
  });

  it('declares no placerId at all', () => {
    // Read off the shape rather than off one parse, so adding the field is
    // caught even if a caller never sends it. If this ever needs relaxing, the
    // reason has to be written down somewhere other than here.
    expect(Object.keys(createStickerPlacementSchema.shape)).toEqual(['imageId', 'data', 'free']);
  });
});
