import { generateJSON } from '@tiptap/html/server';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { extractCloudflareUuid, type ExtractedMedia } from '~/utils/article-helpers';

type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
};

/** Extracts all media (images and videos) from article tiptap/HTML content.
 *  Handles `media` nodes (edge-media), `image` nodes (img tags). */
export function getContentMedia(content: string): ExtractedMedia[] {
  let doc: { content?: TiptapNode[] };
  try {
    if (content.startsWith('{')) {
      doc = JSON.parse(content);
    } else {
      doc = generateJSON(content, tiptapExtensions);
    }
  } catch {
    return [];
  }

  const media: ExtractedMedia[] = [];
  const walk = (nodes: TiptapNode[] | undefined) => {
    if (!nodes) return;
    for (const node of nodes) {
      // edge-media nodes: url is already a UUID
      if (node.type === 'media' && typeof node.attrs?.url === 'string' && node.attrs.url) {
        const type = node.attrs.type === 'video' ? 'video' : 'image';
        media.push({
          url: node.attrs.url,
          type,
          alt: (node.attrs.filename as string) || undefined,
        });
      }

      // img tags: src is a full URL, needs UUID extraction
      if (node.type === 'image' && typeof node.attrs?.src === 'string' && node.attrs.src) {
        const uuid = extractCloudflareUuid(node.attrs.src);
        if (uuid) {
          media.push({
            url: uuid,
            type: 'image',
            alt: (node.attrs.alt as string) || undefined,
          });
        }
      }

      walk(node.content);
    }
  };
  walk(doc.content);
  return media;
}
