import { describe, expect, it } from 'vitest';
import { imageIdFromDrop } from '~/components/AutocompleteSearch/image-drop';
import {
  CIVITAI_MEDIA_ID_MIME,
  CIVITAI_MEDIA_TYPE_MIME,
} from '~/components/EdgeMedia/media-drag-data';

const drop = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? '' });
const CDN = 'https://image.civitai.com/abc/width=450/1.jpeg';

describe('imageIdFromDrop', () => {
  it('reads a site image, whose link is its CDN file', () => {
    expect(
      imageIdFromDrop(
        drop({
          [CIVITAI_MEDIA_ID_MIME]: '42',
          [CIVITAI_MEDIA_TYPE_MIME]: 'image',
          'text/uri-list': CDN,
        })
      )
    ).toBe(42);
  });

  it('carries nothing for a site video, which has no embedding', () => {
    expect(
      imageIdFromDrop(
        drop({
          [CIVITAI_MEDIA_ID_MIME]: '42',
          [CIVITAI_MEDIA_TYPE_MIME]: 'video',
          'text/uri-list': 'https://civitai.com/images/42',
        })
      )
    ).toBeUndefined();
  });

  it('reads a dragged image-page link', () => {
    expect(imageIdFromDrop(drop({ 'text/uri-list': 'https://civitai.com/images/42' }))).toBe(42);
  });

  it('skips uri-list comment lines', () => {
    expect(imageIdFromDrop(drop({ 'text/uri-list': '#/images/9\n/images/7' }))).toBe(7);
  });

  it('reads a link on the given host', () => {
    const data = drop({ 'text/uri-list': 'http://localhost:3000/images/7' });
    expect(imageIdFromDrop(data)).toBeUndefined();
    expect(imageIdFromDrop(data, ['localhost:3000'])).toBe(7);
  });

  it('carries nothing for a dropped file or a picture with no page link', () => {
    expect(imageIdFromDrop(drop({}))).toBeUndefined();
    expect(imageIdFromDrop(drop({ 'text/uri-list': CDN }))).toBeUndefined();
  });
});
