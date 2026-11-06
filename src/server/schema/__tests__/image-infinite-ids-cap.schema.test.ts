import { describe, expect, it } from 'vitest';
import { getInfiniteImagesSchema } from '~/server/schema/image.schema';

const withIds = (n: number) => ({ ids: Array.from({ length: n }, (_, i) => i + 1) });

// Not IMAGE_IDS_BATCH_MAX (100): sticker-book parses up to 200 ids here, and a lower cap fails the whole book.
describe('getInfiniteImagesSchema ids cap', () => {
  it('accepts the 200 ids the sticker book can send', () => {
    expect(getInfiniteImagesSchema.safeParse(withIds(200)).success).toBe(true);
  });

  it('refuses more, since an ids query is served by raw SQL', () => {
    expect(getInfiniteImagesSchema.safeParse(withIds(201)).success).toBe(false);
  });
});
