import { describe, expect, it } from 'vitest';
import {
  buildShowcaseItems,
  canBeCover,
  inheritedSite,
  parseImageId,
} from '../version-showcase.utils';

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

  it('shows an uncurated site the other site’s showcase, without .red-only community images on .com', () => {
    const redOnly = {
      rows: [
        { imageId: 8, site: 'red', source: 'Community', position: 0, excluded: false },
        { imageId: 9, site: 'red', source: 'Community', position: 1, excluded: false },
      ],
      ownerImages: [image(1)],
      community: [
        { ...image(8), site: 'red', authorUsername: 'ann' },
        { ...image(9), nsfwLevel: 4, site: 'red', authorUsername: 'bob' },
      ],
    } as never;
    expect(inheritedSite(redOnly, 'com')).toBe('red');
    expect(inheritedSite(redOnly, 'red')).toBeNull();
    expect(buildShowcaseItems(redOnly, 'com').map((item) => item.imageId)).toEqual([8, 1]);
    expect(buildShowcaseItems(redOnly, 'red').map((item) => item.imageId)).toEqual([8, 9, 1]);
  });
});

describe('canBeCover', () => {
  const owner = { imageId: 1, source: 'Owner', excluded: false, url: 'u1', nsfwLevel: 1 } as const;
  const featured = { ...owner, imageId: 9, source: 'Community' } as const;
  const curated = (site: 'com' | 'red') => ({
    isLatestPublished: true,
    rows: [{ imageId: 9, site, source: 'Community', position: 0, excluded: false }],
  });

  it("offers a featured image saved in this site's own showcase", () => {
    expect(canBeCover(curated('red') as never, 'red', featured)).toBe(true);
  });

  it('refuses a featured image only inherited from the other site', () => {
    expect(canBeCover(curated('red') as never, 'com', featured)).toBe(false);
    expect(canBeCover(curated('red') as never, 'com', owner)).toBe(true);
  });

  it('refuses an image added by link and not saved yet', () => {
    expect(canBeCover(curated('red') as never, 'red', { ...featured, url: undefined })).toBe(false);
  });

  it('refuses a hidden image, one above PG-13 on civitai.com, and any image on an older version', () => {
    expect(canBeCover(curated('com') as never, 'com', { ...owner, excluded: true })).toBe(false);
    expect(canBeCover(curated('com') as never, 'com', { ...owner, nsfwLevel: 4 })).toBe(false);
    expect(canBeCover({ ...curated('red'), isLatestPublished: false } as never, 'red', owner)).toBe(
      false
    );
  });
});
