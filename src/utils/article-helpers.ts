/**
 * Article Image Extraction Utilities - Client Side
 * Uses native browser DOMParser for optimal performance
 */

import { isUUID } from '~/utils/string-helpers';

export type ExtractedMedia = {
  url: string;
  type: 'image' | 'video';
  alt?: string;
};

/**
 * Extract media (images and videos) from article HTML content (CLIENT-SIDE ONLY)
 * Use this in React components, hooks, and client-side code
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
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');

    const media: ExtractedMedia[] = [];

    // Extract standard <img> elements
    const images = Array.from(doc.querySelectorAll('img'));
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
    const edgeMediaElements = Array.from(doc.querySelectorAll('edge-media'));
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
    console.error('Failed to parse article HTML (client):', error);
    return [];
  }
}

/**
 * Extract Cloudflare UUID from Civitai image URL
 *
 * Example URL format:
 * https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/5cd97133-1989-41bd-bdd9-7145e1b5cad6/original=true/5cd97133-1989-41bd-bdd9-7145e1b5cad6.jpeg
 *                                                 ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 *                                                  UUID is in the second path segment
 *
 * @param url - Full Civitai image URL or UUID
 * @returns UUID string if found, or the original URL if it's already a UUID
 */
export function extractCloudflareUuid(url: string): string | null {
  if (!url) return null;
  if (!isValidCivitaiImageUrl(url)) return null;

  // If already a UUID, return as-is
  if (isUUID(url)) return url;

  try {
    const parsed = new URL(url);
    const pathSegments = parsed.pathname.split('/').filter(Boolean);

    // UUID is typically in the second path segment (index 1)
    // Format: /hash/uuid/params/filename
    if (pathSegments.length >= 2) {
      const potentialUuid = pathSegments[1];
      if (isUUID(potentialUuid)) {
        return potentialUuid;
      }
    }

    // Fallback: search all path segments for a UUID
    for (const segment of pathSegments) {
      if (isUUID(segment)) {
        return segment;
      }
    }

    return null;
  } catch {
    // Not a valid URL, return null
    return null;
  }
}

/**
 * Validate image URL is from allowed Civitai domains or is a valid UUID
 * Security measure to prevent injection of external URLs
 *
 * Supports two formats:
 * 1. Full URLs from allowed Civitai domains
 * 2. UUID format (e.g., "f1f87d35-81ca-4c55-a705-5d518f59d2ce")
 *
 * @param url - Image URL or UUID to validate
 * @returns True if URL is from allowed domain or is a valid UUID
 */
export function isValidCivitaiImageUrl(url: string): boolean {
  if (!url) return false;
  // Check if it's a UUID format (stored as Cloudflare image ID)
  if (isUUID(url)) return true;

  // Check if it's a full URL from allowed domains
  try {
    const parsed = new URL(url);
    const allowedHosts = [
      'image.civitai.com',
      'civitai.com',
      'wasabisys.com',
      'civitai-prod.s3.amazonaws.com',
    ];

    return allowedHosts.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith('.' + host)
    );
  } catch {
    // Not a valid URL, and not a UUID, so invalid
    return false;
  }
}
