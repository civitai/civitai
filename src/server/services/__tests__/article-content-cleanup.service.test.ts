import { describe, it, expect, vi } from 'vitest';

vi.mock('~/utils/s3-client', () => ({ imageS3Client: {} }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: vi.fn() }));

import {
  getContentMedia,
  getContentImageUrls,
} from '~/server/services/article-content-cleanup.service';

const UUID_1 = 'f1f87d35-81ca-4c55-a705-5d518f59d2ce';
const UUID_2 = 'a2b3c4d5-6789-0abc-def1-234567890abc';
const UUID_3 = 'c3d4e5f6-7890-1bcd-ef23-456789012345';

// Helper to build tiptap JSON
function tiptapDoc(...nodes: object[]) {
  return JSON.stringify({ type: 'doc', content: nodes });
}

function mediaNode(url: string, type: 'image' | 'video' = 'image', filename?: string) {
  return { type: 'media', attrs: { url, type, filename: filename ?? null } };
}

function imageNode(src: string, alt?: string) {
  return { type: 'image', attrs: { src, alt: alt ?? null } };
}

describe('getContentMedia', () => {
  describe('media nodes (edge-media)', () => {
    it('extracts an image media node', () => {
      const content = tiptapDoc(mediaNode(UUID_1, 'image', 'photo.jpg'));
      expect(getContentMedia(content)).toEqual([
        { url: UUID_1, type: 'image', alt: 'photo.jpg' },
      ]);
    });

    it('extracts a video media node', () => {
      const content = tiptapDoc(mediaNode(UUID_1, 'video', 'clip.mp4'));
      expect(getContentMedia(content)).toEqual([
        { url: UUID_1, type: 'video', alt: 'clip.mp4' },
      ]);
    });

    it('defaults to image when type is not video', () => {
      const doc = JSON.stringify({
        type: 'doc',
        content: [{ type: 'media', attrs: { url: UUID_1, type: 'audio', filename: null } }],
      });
      expect(getContentMedia(doc)).toEqual([
        { url: UUID_1, type: 'image', alt: undefined },
      ]);
    });

    it('skips media nodes with empty url', () => {
      const doc = JSON.stringify({
        type: 'doc',
        content: [{ type: 'media', attrs: { url: '', type: 'image', filename: null } }],
      });
      expect(getContentMedia(doc)).toEqual([]);
    });
  });

  describe('image nodes (img tags)', () => {
    it('extracts UUID from a full Cloudflare image URL', () => {
      const src = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${UUID_2}/original=true/img.jpeg`;
      const content = tiptapDoc(imageNode(src, 'A cool image'));
      expect(getContentMedia(content)).toEqual([
        { url: UUID_2, type: 'image', alt: 'A cool image' },
      ]);
    });

    it('skips image nodes with non-Civitai URLs', () => {
      const content = tiptapDoc(imageNode('https://external.com/photo.jpg'));
      expect(getContentMedia(content)).toEqual([]);
    });

    it('skips image nodes with empty src', () => {
      const doc = JSON.stringify({
        type: 'doc',
        content: [{ type: 'image', attrs: { src: '', alt: null } }],
      });
      expect(getContentMedia(doc)).toEqual([]);
    });
  });

  describe('mixed content', () => {
    it('extracts both media and image nodes', () => {
      const src = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${UUID_2}/original=true/img.jpeg`;
      const content = tiptapDoc(
        mediaNode(UUID_1, 'image', 'photo.jpg'),
        imageNode(src, 'alt text'),
        mediaNode(UUID_3, 'video')
      );
      expect(getContentMedia(content)).toEqual([
        { url: UUID_1, type: 'image', alt: 'photo.jpg' },
        { url: UUID_2, type: 'image', alt: 'alt text' },
        { url: UUID_3, type: 'video', alt: undefined },
      ]);
    });
  });

  describe('HTML input', () => {
    it('extracts media from edge-media HTML tags', () => {
      const html = `<edge-media url="${UUID_1}" type="image" filename="test.jpg"></edge-media>`;
      const result = getContentMedia(html);
      expect(result).toEqual([{ url: UUID_1, type: 'image', alt: 'test.jpg' }]);
    });

    it('extracts media from img HTML tags', () => {
      const src = `https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/${UUID_1}/original=true/img.jpeg`;
      const html = `<img src="${src}" alt="my image" />`;
      const result = getContentMedia(html);
      expect(result).toEqual([{ url: UUID_1, type: 'image', alt: 'my image' }]);
    });
  });

  describe('edge cases', () => {
    it('returns empty array for empty string', () => {
      expect(getContentMedia('')).toEqual([]);
    });

    it('returns empty array for invalid JSON', () => {
      expect(getContentMedia('{not valid json')).toEqual([]);
    });

    it('returns empty array for content with no media', () => {
      const content = tiptapDoc({ type: 'paragraph', content: [] });
      expect(getContentMedia(content)).toEqual([]);
    });

    it('finds media in nested content', () => {
      const content = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'blockquote',
            content: [mediaNode(UUID_1, 'image', 'nested.jpg')],
          },
        ],
      });
      expect(getContentMedia(content)).toEqual([
        { url: UUID_1, type: 'image', alt: 'nested.jpg' },
      ]);
    });
  });
});

describe('getContentImageUrls', () => {
  it('returns only image URLs, excluding videos', () => {
    const content = tiptapDoc(
      mediaNode(UUID_1, 'image'),
      mediaNode(UUID_2, 'video'),
      mediaNode(UUID_3, 'image')
    );
    expect(getContentImageUrls(content)).toEqual([UUID_1, UUID_3]);
  });

  it('returns empty array for no images', () => {
    const content = tiptapDoc(mediaNode(UUID_1, 'video'));
    expect(getContentImageUrls(content)).toEqual([]);
  });
});
