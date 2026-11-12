/**
 * The article document: one text per article, embedded for semantic search and stored as
 * `search_text` for phrase filters.
 */
import { createHash } from 'crypto';
import sanitize from 'sanitize-html';
import { cleanHtml, DOCUMENT_MAX_CHARS } from '../models/document';

export type ArticleSource = {
  title: string;
  username: string | null;
  tags: string[];
  content: string | null;
};

/**
 * Drops every element marked `data-type="spoiler"` with its contents, so a search never matches on
 * hidden text. A copy of the site's `removeSpoilers` (src/utils/html-sanitize-helpers.ts), which
 * the event-engine cannot import.
 */
export function removeSpoilers(html: string) {
  if (!html || !/spoiler/i.test(html)) return html;
  return sanitize(html, {
    allowedTags: false,
    allowedAttributes: false,
    // Nothing here is rendered (cleanHtml drops script and style next); silences a warning per call.
    allowVulnerableTags: true,
    exclusiveFilter: (frame) => frame.attribs['data-type']?.trim().toLowerCase() === 'spoiler',
  });
}

export function articleDocument(article: ArticleSource) {
  const tags = [...new Set(article.tags.map(cleanHtml).filter(Boolean))];
  const text = [
    `Title: ${cleanHtml(article.title)}`,
    `Creator: ${article.username ?? ''}`,
    `Tags: ${tags.join(', ')}`,
    `Content: ${cleanHtml(removeSpoilers(article.content ?? ''))}`,
  ]
    .join('\n')
    // Code points, so a cut never splits a surrogate pair.
    .match(/[\s\S]/gu)!
    .slice(0, DOCUMENT_MAX_CHARS)
    .join('');
  return { text, tags, docHash: createHash('sha256').update(text).digest('hex') };
}
