/**
 * The comic document: one text per comic project, embedded for semantic search and stored as
 * `search_text` for phrase filters. Project fields only: no chapters, no panel prompts.
 */
import { createHash } from 'crypto';
import { cleanHtml, DOCUMENT_MAX_CHARS } from '../models/document';

export type ComicSource = {
  name: string;
  username: string | null;
  genre: string | null;
  description: string | null;
};

export function comicDocument(comic: ComicSource) {
  const text = [
    `Name: ${cleanHtml(comic.name)}`,
    `Creator: ${comic.username ?? ''}`,
    `Genre: ${comic.genre ?? ''}`,
    `Description: ${cleanHtml(comic.description)}`,
  ]
    .join('\n')
    // Code points, so a cut never splits a surrogate pair.
    .match(/[\s\S]/gu)!
    .slice(0, DOCUMENT_MAX_CHARS)
    .join('');
  return { text, docHash: createHash('sha256').update(text).digest('hex') };
}
