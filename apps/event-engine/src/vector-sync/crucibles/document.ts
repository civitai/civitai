/**
 * The crucible document: one text per crucible, embedded for semantic search and stored as
 * `search_text` for phrase filters. Never the moderator event tags.
 */
import { createHash } from 'crypto';
import { cleanHtml, DOCUMENT_MAX_CHARS } from '../models/document';

export type CrucibleSource = {
  name: string;
  username: string | null;
  description: string | null;
};

export function crucibleDocument(crucible: CrucibleSource) {
  const text = [
    `Name: ${cleanHtml(crucible.name)}`,
    `Creator: ${crucible.username ?? ''}`,
    `Description: ${cleanHtml(crucible.description)}`,
  ]
    .join('\n')
    // Code points, so a cut never splits a surrogate pair.
    .match(/[\s\S]/gu)!
    .slice(0, DOCUMENT_MAX_CHARS)
    .join('');
  return { text, docHash: createHash('sha256').update(text).digest('hex') };
}
