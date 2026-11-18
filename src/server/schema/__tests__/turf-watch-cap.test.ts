import { describe, expect, it } from 'vitest';
import { MAX_TURF_IMAGES_PER_MARK, watchTurfImagesSchema } from '~/server/schema/turf.schema';

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe('watchTurfImagesSchema imageIds cap', () => {
  it('is 50', () => {
    expect(MAX_TURF_IMAGES_PER_MARK).toBe(50);
  });

  it('accepts a full chunk of MAX_TURF_IMAGES_PER_MARK ids', () => {
    const parsed = watchTurfImagesSchema.safeParse({
      event: 'e',
      imageIds: ids(MAX_TURF_IMAGES_PER_MARK),
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses one id more', () => {
    const parsed = watchTurfImagesSchema.safeParse({
      event: 'e',
      imageIds: ids(MAX_TURF_IMAGES_PER_MARK + 1),
    });
    expect(parsed.success).toBe(false);
  });
});
