/**
 * The collection document: one text per collection, embedded for semantic search and stored as
 * `search_text` for phrase filters.
 */
import { createHash } from 'crypto';
import { cleanHtml, DOCUMENT_MAX_CHARS } from '../models/document';

export type CollectionSource = {
  name: string;
  username: string | null;
  type: string | null;
  description: string | null;
};

export function collectionDocument(collection: CollectionSource) {
  const text = [
    `Name: ${cleanHtml(collection.name)}`,
    `Creator: ${collection.username ?? ''}`,
    `Type: ${collection.type ?? ''}`,
    `Description: ${cleanHtml(collection.description)}`,
  ]
    .join('\n')
    // Code points, so a cut never splits a surrogate pair.
    .match(/[\s\S]/gu)!
    .slice(0, DOCUMENT_MAX_CHARS)
    .join('');
  return { text, docHash: createHash('sha256').update(text).digest('hex') };
}
