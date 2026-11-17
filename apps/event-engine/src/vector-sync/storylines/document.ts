/**
 * The storyline document: one text per storyline, embedded for semantic search and stored as
 * `search_text` for phrase filters. The title, its creator and chapter 1's opening.
 */
import { createHash } from 'crypto';
import { cleanHtml, DOCUMENT_MAX_CHARS } from '../models/document';

export type StorylineSource = {
  title: string;
  username: string | null;
  openingTitle: string | null;
  openingDetail: string | null;
};

export function storylineDocument(storyline: StorylineSource) {
  const opening = [cleanHtml(storyline.openingTitle), cleanHtml(storyline.openingDetail)]
    .filter(Boolean)
    .join('. ');
  const text = [
    `Title: ${cleanHtml(storyline.title)}`,
    `Creator: ${storyline.username ?? ''}`,
    `Opening: ${opening}`,
  ]
    .join('\n')
    // Code points, so a cut never splits a surrogate pair.
    .match(/[\s\S]/gu)!
    .slice(0, DOCUMENT_MAX_CHARS)
    .join('');
  return { text, docHash: createHash('sha256').update(text).digest('hex') };
}
