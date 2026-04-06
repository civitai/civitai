import { env } from '~/env/server';
import { imageS3Client } from '~/utils/s3-client';
import { generateJSON } from '@tiptap/html/server';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { logToAxiom } from '~/server/logging/client';
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

/** Extracts just the image URLs (UUIDs) from article content. */
export function getContentImageUrls(content: string): string[] {
  return getContentMedia(content)
    .filter((m) => m.type === 'image')
    .map((m) => m.url);
}

/** Deletes all inline images from an article's content from S3/CF */
export async function deleteArticleContentImages(content: string) {
  const urls = getContentImageUrls(content);
  if (!urls.length) return;

  try {
    await imageS3Client.deleteManyObjects({
      bucket: env.S3_IMAGE_UPLOAD_BUCKET,
      keys: urls,
    });
  } catch (e) {
    logToAxiom(
      {
        type: 'error',
        message: 'Failed to delete article content images',
        error: (e as Error).message,
        urls,
      },
      'civitai-blue'
    ).catch();
  }
}
