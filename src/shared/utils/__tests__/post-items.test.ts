import { describe, expect, test } from 'vitest';
import { comparePostItems, textIndexAfter } from '~/shared/utils/post-items';

const image = (id: number, index: number) => ({ type: 'image' as const, id, index });
const text = (id: number, index: number) => ({ type: 'text' as const, id, index });

describe('comparePostItems', () => {
  test('a text item sits after the item whose index it took, images first on a tie', () => {
    const order = [text(9, 1), image(2, 1), text(4, 1), image(1, 0), image(3, 2)].sort(
      comparePostItems
    );
    expect(order.map((x) => `${x.type}${x.id}`)).toEqual([
      'image1',
      'image2',
      'text4',
      'text9',
      'image3',
    ]);
  });

  test('a text added before every item sorts first', () => {
    const items = [image(1, 0), image(2, 1)];
    const added = text(5, textIndexAfter(undefined, items[0]));
    expect([...items, added].sort(comparePostItems)[0]).toBe(added);
  });

  test('a text added after an item lands right behind it', () => {
    const items = [image(1, 0), image(2, 1)];
    const added = text(5, textIndexAfter(items[0], undefined));
    expect([...items, added].sort(comparePostItems).map((x) => x.id)).toEqual([1, 5, 2]);
  });
});
