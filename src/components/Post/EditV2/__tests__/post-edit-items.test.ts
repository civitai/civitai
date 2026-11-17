import { describe, expect, test } from 'vitest';
import type { ControlledImage } from '~/components/Post/EditV2/PostEditProvider';
import { reorderPayload } from '~/components/Post/EditV2/post-edit-items';

const image = (id: number, index: number) =>
  ({ type: 'added', data: { id, index, url: `u${id}` } } as unknown as ControlledImage);
const text = (id: number, index: number) => ({ id, index, content: '' });

// Images 10 and 11 hold indexes 0 and 2; texts 5 and 6 sit after 10 and after 11.
const images = [image(11, 2), image(10, 0)];
const texts = [text(6, 2), text(5, 0)];

describe('reorderPayload', () => {
  test('with the flag on, sends the whole reading order, texts included', () => {
    expect(reorderPayload({ postId: 1, images, texts, textOn: true }).items).toEqual([
      { type: 'image', id: 10 },
      { type: 'text', id: 5 },
      { type: 'image', id: 11 },
      { type: 'text', id: 6 },
    ]);
  });

  test('with the flag off, sends images only: the server refuses `items` without it', () => {
    const payload = reorderPayload({ postId: 1, images, texts, textOn: false });
    expect(payload).toEqual({ id: 1, imageIds: [11, 10] });
    expect(payload).not.toHaveProperty('items');
  });
});
