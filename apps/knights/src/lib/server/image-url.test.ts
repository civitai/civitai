import { afterEach, describe, expect, it } from 'vitest';
import { imageUrl } from './image-url';

afterEach(() => {
  delete process.env.IMAGE_LOCATION;
});

describe('imageUrl', () => {
  it('serves the stored key from the image CDN at a fixed width', () => {
    process.env.IMAGE_LOCATION = 'https://cdn.example/acct';
    expect(imageUrl('abc-123')).toBe('https://cdn.example/acct/abc-123/width=800/abc-123.jpeg');
  });
});
