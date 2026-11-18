/**
 * The bounty document: one text per bounty, embedded for semantic search and stored as
 * `search_text` for phrase filters.
 */
import { createHash } from 'crypto';
import { cleanHtml, DOCUMENT_MAX_CHARS } from '../models/document';

export type BountySource = {
  name: string;
  username: string | null;
  type: string;
  baseModel: string | null;
  tags: string[];
  description: string | null;
};

export function bountyDocument(bounty: BountySource) {
  const text = [
    `Name: ${cleanHtml(bounty.name)}`,
    `Creator: ${bounty.username ?? ''}`,
    `Type: ${bounty.type}`,
    `Base model: ${bounty.baseModel ?? ''}`,
    `Tags: ${bounty.tags.join(', ')}`,
    `Description: ${cleanHtml(bounty.description)}`,
  ]
    .join('\n')
    // Code points, so a cut never splits a surrogate pair.
    .match(/[\s\S]/gu)!
    .slice(0, DOCUMENT_MAX_CHARS)
    .join('');
  return { text, docHash: createHash('sha256').update(text).digest('hex') };
}
