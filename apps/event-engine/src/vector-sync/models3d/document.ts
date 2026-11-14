/**
 * The 3D model document. Its vector is the thumbnail image; this text is stored as `search_text`
 * for the search service's exact-title and phrase passes.
 */
import { createHash } from 'crypto';
import { cleanHtml, DOCUMENT_MAX_CHARS } from '../models/document';

export type Model3DSource = {
  name: string;
  username: string | null;
  tags: string[];
  description: string | null;
  /** The embedded image: a new thumbnail must re-embed even when the text is unchanged. */
  thumbnailImageId: number;
  thumbnailUrl: string;
};

export function model3dDocument(model: Model3DSource) {
  const tags = [...new Set(model.tags.map(cleanHtml).filter(Boolean))];
  const text = [
    `Name: ${cleanHtml(model.name)}`,
    `Creator: ${model.username ?? ''}`,
    `Tags: ${tags.join(', ')}`,
    `Description: ${cleanHtml(model.description)}`,
  ]
    .join('\n')
    // Code points, so a cut never splits a surrogate pair.
    .match(/[\s\S]/gu)!
    .slice(0, DOCUMENT_MAX_CHARS)
    .join('');
  const docHash = createHash('sha256')
    .update(`${model.thumbnailImageId}\n${model.thumbnailUrl}\n${text}`)
    .digest('hex');
  return { text, tags, docHash };
}
