/**
 * Article Image Extraction Utilities - Server Side
 * Uses JSDOM for HTML parsing in Node.js environment
 */

import { JSDOM } from 'jsdom';
import { extractCloudflareUuid, type ExtractedMedia } from '~/utils/article-helpers';

/**
 * Extract media (images and videos) from article HTML content (SERVER-SIDE ONLY)
 * Use this in server services, API routes, and backend code
 *
 * Supports both:
 * - Standard <img> tags
 * - Custom <edge-media> TipTap nodes (with type attribute)
 *
 * @param htmlContent - Article HTML content from TipTap editor
 * @returns Array of media items with UUID (extracted from URL), type, and optional alt text
 */
export function extractImagesFromArticle(htmlContent: string): ExtractedMedia[] {
  if (!htmlContent?.trim()) return [];

  try {
    const dom = new JSDOM(htmlContent);
    const document = dom.window.document;

    const media: ExtractedMedia[] = [];

    // Extract standard <img> elements
    const images: HTMLImageElement[] = Array.from(document.querySelectorAll('img'));
    images.forEach((img) => {
      const uuid = extractCloudflareUuid(img.src);
      if (uuid) {
        media.push({
          url: uuid,
          type: 'image',
          alt: img.alt || undefined,
        });
      }
    });

    // Extract custom <edge-media> elements
    const edgeMediaElements: Element[] = Array.from(document.querySelectorAll('edge-media'));
    edgeMediaElements.forEach((element) => {
      const url = element.getAttribute('url');
      const type = element.getAttribute('type') as 'image' | 'video' | null;
      const filename = element.getAttribute('filename');

      const uuid = url ? extractCloudflareUuid(url) : null;
      if (uuid) {
        media.push({
          url: uuid,
          type: type || 'image',
          alt: filename || undefined,
        });
      }
    });

    return media;
  } catch (error) {
    console.error('Failed to parse article HTML (server):', error);
    return [];
  }
}
