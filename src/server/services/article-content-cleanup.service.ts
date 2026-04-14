import { env } from '~/env/server';
import { imageS3Client } from '~/utils/s3-client';
import { generateJSON } from '@tiptap/html/server';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { logToAxiom } from '~/server/logging/client';

type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
};

/** Extracts all media image URLs (UUIDs) from a tiptap JSON document */
export function getContentImageUrls(content: string): string[] {
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

  const urls: string[] = [];
  const walk = (nodes: TiptapNode[] | undefined) => {
    if (!nodes) return;
    for (const node of nodes) {
      if (
        node.type === 'media' &&
        node.attrs?.type === 'image' &&
        typeof node.attrs.url === 'string' &&
        node.attrs.url
      ) {
        urls.push(node.attrs.url);
      }
      walk(node.content);
    }
  };
  walk(doc.content);
  return urls;
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
