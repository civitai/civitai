import { describe, expect, it } from 'vitest';
import { imageIdFromDrop } from '~/components/AutocompleteSearch/image-drop';

const drop = (data: Record<string, string>) => ({ getData: (type: string) => data[type] ?? '' });

describe('imageIdFromDrop', () => {
  it('reads an image card dragged from the site', () => {
    expect(imageIdFromDrop(drop({ 'text/uri-list': 'https://civitai.com/images/42' }))).toBe(42);
  });

  it('skips uri-list comments and falls back to the plain text', () => {
    expect(
      imageIdFromDrop(
        drop({ 'text/uri-list': '# dragged\nhttps://example.com/x', 'text/plain': '/images/7' })
      )
    ).toBe(7);
  });

  it('carries nothing for a dropped file or a picture with no page link', () => {
    expect(imageIdFromDrop(drop({}))).toBeUndefined();
    expect(
      imageIdFromDrop(drop({ 'text/uri-list': 'https://image.civitai.com/abc/width=450/1.jpeg' }))
    ).toBeUndefined();
  });
});
