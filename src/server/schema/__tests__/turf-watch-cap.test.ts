import { describe, expect, it } from 'vitest';
import { MAX_TURF_IMAGES_PER_MARK, watchTurfImagesSchema } from '~/server/schema/turf.schema';

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

/**
 * The client watchers chunk by MAX_TURF_IMAGES_PER_MARK and the server slices by it, so the
 * schema must accept exactly that many ids per call: a chunk the schema refuses is a mark lost.
 */
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
