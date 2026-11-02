import { afterEach, describe, expect, it } from 'vitest';
import { imagePageUrl, imageUrl } from './image-url';

afterEach(() => {
  delete process.env.IMAGE_LOCATION;
});

describe('imagePageUrl', () => {
  it('points at the image on the main site', () => {
    process.env.CIVITAI_APP_URL = 'https://main.example/';
    expect(imagePageUrl(42)).toBe('https://main.example/images/42');
    delete process.env.CIVITAI_APP_URL;
    expect(imagePageUrl(42)).toBe('https://civitai.com/images/42');
  });
});

describe('imageUrl', () => {
  it('serves the stored key from the image CDN at a fixed width', () => {
    process.env.IMAGE_LOCATION = 'https://cdn.example/acct';
    expect(imageUrl('abc-123')).toBe('https://cdn.example/acct/abc-123/width=800/abc-123.jpeg');
  });

  it('serves a narrower variant on request', () => {
    process.env.IMAGE_LOCATION = 'https://cdn.example/acct';
    expect(imageUrl('abc-123', 192)).toBe(
      'https://cdn.example/acct/abc-123/width=192/abc-123.jpeg'
    );
  });
});
