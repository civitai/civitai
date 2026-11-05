import { describe, expect, it } from 'vitest';
import { placeTurfStickerSchema } from '~/server/schema/turf.schema';
import { STICKER_PLACEMENT_MIN_OPACITY } from '~/shared/utils/sticker-placement';

const place = (data: Record<string, unknown>) =>
  placeTurfStickerSchema.safeParse({ event: 'e', imageId: 1, cosmeticId: 2, data });

const pose = { x: 0.3, y: 0.7, scale: 0.31, rotation: -40, flip: true };

describe('a hat is placed with the whole sticker pose', () => {
  it('keeps every field the sticker editor sends, opacity included', () => {
    const parsed = place({ ...pose, opacity: 0.6 });
    expect(parsed.success && parsed.data.data).toEqual({ ...pose, opacity: 0.6 });
  });

  it('defaults opacity for a client from before hats had it', () => {
    const parsed = place(pose);
    expect(parsed.success && parsed.data.data.opacity).toBe(1);
  });

  it('refuses an opacity under the sticker floor, as a sticker does', () => {
    expect(place({ ...pose, opacity: STICKER_PLACEMENT_MIN_OPACITY / 2 }).success).toBe(false);
  });
});
