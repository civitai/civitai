import { afterEach, describe, expect, it } from 'vitest';
import { imagePageUrl, imageUrl } from './image-url';

afterEach(() => {
  delete process.env.IMAGE_LOCATION;
  delete process.env.CIVITAI_APP_URL;
  delete process.env.CIVITAI_SITE_URL;
});

describe('imagePageUrl', () => {
  it('points at the image on the configured site', () => {
    process.env.CIVITAI_SITE_URL = 'https://site.example/';
    expect(imagePageUrl(42)).toBe('https://site.example/images/42');
  });

  it('defaults to civitai.red, so an R+ image opens, and ignores the server-to-server base', () => {
    process.env.CIVITAI_APP_URL = 'https://civitai.com';
    expect(imagePageUrl(42)).toBe('https://civitai.red/images/42');
  });
});

describe('imageUrl', () => {
  it('serves the stored key from the image CDN at a fixed width, compressed and without animation', () => {
    process.env.IMAGE_LOCATION = 'https://cdn.example/acct';
    expect(imageUrl('abc-123')).toBe(
      'https://cdn.example/acct/abc-123/width=1200,optimized=true/abc-123.jpeg'
    );
  });

  it('serves a narrower variant on request', () => {
    process.env.IMAGE_LOCATION = 'https://cdn.example/acct';
    expect(imageUrl('abc-123', 192)).toBe(
      'https://cdn.example/acct/abc-123/width=192,optimized=true/abc-123.jpeg'
    );
  });
});
