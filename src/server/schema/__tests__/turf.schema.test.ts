import { describe, expect, it } from 'vitest';
import { placeTurfStickerSchema } from '~/server/schema/turf.schema';
import { STICKER_PLACEMENT_MIN_OPACITY } from '~/shared/utils/sticker-placement';
import { HAT_MAX_SCALE } from '~/server/schema/turf.schema';

const place = (data: Record<string, unknown>) =>
  placeTurfStickerSchema.safeParse({ event: 'e', imageId: 1, cosmeticId: 2, data });

const pose = { x: 0.3, y: 0.7, scale: 0.21, rotation: -40, flip: true };

describe('a hat is placed with the whole sticker pose', () => {
  it('keeps every field the sticker editor sends', () => {
    const parsed = place({ ...pose, opacity: 1 });
    expect(parsed.success && parsed.data.data).toEqual({ ...pose, opacity: 1 });
    expect(place(pose).success).toBe(true);
  });

  // Decided: hats stay opaque. Do not widen this back to a sticker's opacity range.
  it('refuses a see-through hat', () => {
    expect(place({ ...pose, opacity: 0.6 }).success).toBe(false);
    expect(place({ ...pose, opacity: STICKER_PLACEMENT_MIN_OPACITY }).success).toBe(false);
  });

  // A free hat on anyone's picture gets a sticker's default ceiling, not the creator-raisable maximum.
  it('refuses a hat bigger than a sticker gets by default', () => {
    expect(place({ ...pose, scale: HAT_MAX_SCALE }).success).toBe(true);
    expect(place({ ...pose, scale: HAT_MAX_SCALE + 0.01 }).success).toBe(false);
  });
});
