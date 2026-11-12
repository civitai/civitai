import { describe, expect, it } from 'vitest';
import { buildShowcaseItems, parseImageId } from '../version-showcase.utils';

describe('parseImageId', () => {
  it('reads the id from an image link, with or without a query, or a bare number', () => {
    expect(parseImageId('https://civitai.com/images/12345')).toBe(12345);
    expect(parseImageId('https://civitai.red/images/678/?postId=1#x')).toBe(678);
    expect(parseImageId(' 42 ')).toBe(42);
  });
  it('refuses anything else', () => {
    expect(parseImageId('https://civitai.com/models/12')).toBeNull();
    expect(parseImageId('not an image')).toBeNull();
    expect(parseImageId('')).toBeNull();
  });
});

describe('buildShowcaseItems', () => {
  const image = (id: number) => ({
    id,
    url: `u${id}`,
    type: 'image',
    metadata: null,
    nsfwLevel: 1,
  });
  const data = {
    rows: [
      { imageId: 2, site: 'red', source: 'Owner', position: null, excluded: true },
      { imageId: 9, site: 'red', source: 'Community', position: 0, excluded: false },
      { imageId: 3, site: 'red', source: 'Owner', position: 1, excluded: false },
      { imageId: 1, site: 'com', source: 'Owner', position: 0, excluded: false },
    ],
    ownerImages: [image(1), image(2), image(3)],
    community: [{ ...image(9), site: 'red', authorUsername: 'ann' }],
  } as never;

  it('lists one site in carousel order: positioned first, then the rest, hidden ones marked', () => {
    const items = buildShowcaseItems(data, 'red');
    expect(items.map((item) => [item.imageId, item.excluded])).toEqual([
      [9, false],
      [3, false],
      [1, false],
      [2, true],
    ]);
    expect(items[0]).toMatchObject({ source: 'Community', author: 'ann' });
  });

  it('keeps each site separate', () => {
    expect(buildShowcaseItems(data, 'com').map((item) => item.imageId)).toEqual([1, 2, 3]);
  });
});
