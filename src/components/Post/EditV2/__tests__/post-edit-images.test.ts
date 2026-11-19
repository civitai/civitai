import { describe, expect, it } from 'vitest';
import { dedupeAddedImages } from '~/components/Post/EditV2/post-edit-images';
import type { ControlledImage } from '~/components/Post/EditV2/PostEditProvider';

const added = (id: number, index: number) =>
  ({ type: 'added', data: { id, index } } as unknown as ControlledImage);
const resolving = (url: string) =>
  ({ type: 'resolving', data: { url } } as unknown as ControlledImage);

describe('dedupeAddedImages', () => {
  it('shows one tile for an image id pushed twice, keeping the first', () => {
    const result = dedupeAddedImages([added(149466458, 1), added(7, 2), added(149466458, 3)]);
    expect(result.map((x) => (x.type === 'added' ? x.data.id : null))).toEqual([149466458, 7]);
    expect((result[0].data as { index: number }).index).toBe(1);
  });

  it('leaves in-progress tiles alone, even when they look alike', () => {
    const items = [resolving('a'), resolving('a'), added(1, 1)];
    expect(dedupeAddedImages(items)).toHaveLength(3);
  });
});
