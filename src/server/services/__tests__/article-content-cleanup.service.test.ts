import { describe, it, expect } from 'vitest';

import { getContentMedia } from '~/server/services/article-content-cleanup.service';

const UUID_1 = 'f1f87d35-81ca-4c55-a705-5d518f59d2ce';
const UUID_2 = 'a2b3c4d5-6789-0abc-def1-234567890abc';
const UUID_3 = 'c3d4e5f6-7890-1bcd-ef23-456789012345';

// `Article.content` is sanitized HTML — both callers (`linkArticleContentImages` and the
// migrate-article-images admin endpoint) pass the column straight through.
function edgeMedia(url: string, type: 'image' | 'video' | 'audio' = 'image', filename?: string) {
  const name = filename ? ` filename="${filename}"` : '';
  return `<edge-media url="${url}" type="${type}"${name}></edge-media>`;
}

function img(src: string, alt?: string) {
  return `<img src="${src}"${alt ? ` alt="${alt}"` : ''} />`;
}

const cloudflareUrl = (uuid: string) =>
  `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${uuid}/original=true/img.jpeg`;

describe('getContentMedia', () => {
  describe('media nodes (edge-media)', () => {
    it('extracts an image media node', () => {
      expect(getContentMedia(edgeMedia(UUID_1, 'image', 'photo.jpg'))).toEqual([
        { url: UUID_1, type: 'image', alt: 'photo.jpg' },
      ]);
    });

    it('extracts a video media node', () => {
      expect(getContentMedia(edgeMedia(UUID_1, 'video', 'clip.mp4'))).toEqual([
        { url: UUID_1, type: 'video', alt: 'clip.mp4' },
      ]);
    });

    it('defaults to image when type is not video', () => {
      expect(getContentMedia(edgeMedia(UUID_1, 'audio'))).toEqual([
        { url: UUID_1, type: 'image', alt: undefined },
      ]);
    });

    it('skips media nodes with empty url', () => {
      expect(getContentMedia(edgeMedia('', 'image'))).toEqual([]);
    });
  });

  describe('image nodes (img tags)', () => {
    it('extracts UUID from a full Cloudflare image URL', () => {
      expect(getContentMedia(img(cloudflareUrl(UUID_2), 'A cool image'))).toEqual([
        { url: UUID_2, type: 'image', alt: 'A cool image' },
      ]);
    });

    it('skips image nodes with non-Civitai URLs', () => {
      expect(getContentMedia(img('https://external.com/photo.jpg'))).toEqual([]);
    });

    it('skips image nodes with empty src', () => {
      expect(getContentMedia(img(''))).toEqual([]);
    });
  });

  describe('mixed content', () => {
    it('extracts both media and image nodes', () => {
      const content = [
        edgeMedia(UUID_1, 'image', 'photo.jpg'),
        `<p>${img(cloudflareUrl(UUID_2), 'alt text')}</p>`,
        edgeMedia(UUID_3, 'video'),
      ].join('');

      expect(getContentMedia(content)).toEqual([
        { url: UUID_1, type: 'image', alt: 'photo.jpg' },
        { url: UUID_2, type: 'image', alt: 'alt text' },
        { url: UUID_3, type: 'video', alt: undefined },
      ]);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty string', () => {
      expect(getContentMedia('')).toEqual([]);
    });

    it('returns empty array for content with no media', () => {
      expect(getContentMedia('<p>just words</p>')).toEqual([]);
    });

    it('finds media in nested content', () => {
      const content = `<blockquote><p>${edgeMedia(UUID_1, 'image', 'nested.jpg')}</p></blockquote>`;

      expect(getContentMedia(content)).toEqual([{ url: UUID_1, type: 'image', alt: 'nested.jpg' }]);
    });

    // Content is never parsed as JSON — a crafted body would otherwise let an author link
    // arbitrary CDN uuids to their own article through `linkArticleContentImages`.
    it('ignores media declared in a JSON body', () => {
      const doc = JSON.stringify({
        type: 'doc',
        content: [{ type: 'media', attrs: { url: UUID_1, type: 'image', filename: null } }],
      });

      expect(getContentMedia(doc)).toEqual([]);
    });

    it('returns empty array for malformed JSON', () => {
      expect(getContentMedia('{not valid json')).toEqual([]);
    });
  });
});
