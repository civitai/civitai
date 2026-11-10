import type { Pool } from 'pg';
import { normalizeTitle, nsfwLevels } from '../models/document';
import { articleDocument } from './document';

/**
 * Which articles get a point: the site's `articleSemanticEligibleWhere` (articles.search-index.ts)
 * as SQL. The site's article-eligibility parity test runs both against one database and fails
 * when they keep different articles, so a change to either has to change both.
 */
export const ARTICLE_ELIGIBLE_SQL = `a."publishedAt" IS NOT NULL AND a.status = 'Published'
  AND a.ingestion = 'Scanned' AND NOT a."tosViolation" AND a.availability = 'Public'
  AND NOT a.unlisted AND u."bannedAt" IS NULL`;

/** Characters of content read; the document keeps far fewer, after spoilers and tags go. */
const CONTENT_READ_CHARS = 40_000;

export type ArticlePayload = {
  /** Exact-title key, see normalizeTitle. */
  title_normalized: string;
  /** The embedded document, for phrase filters. */
  search_text: string;
  title: string;
  /** Tag names, for the search service's dictionaries; tagIds is the filter. */
  tags: string[];
  tagIds: number[];
  /** The set bits of Article.nsfwLevel; empty while unrated, so no browsing level matches it. */
  nsfwLevel: number[];
  publishedAt: string;
  userId: number;
  username: string | null;
  coverImageId: number | null;
  isOfficial: boolean;
  /** sha256 of search_text: a point whose hash differs is re-embedded. */
  docHash: string;
  /** Set on write, see withPayloadHash. */
  payloadHash?: string;
};

type Row = {
  id: number;
  title: string;
  content: string | null;
  nsfwLevel: number;
  publishedAt: Date;
  userId: number;
  username: string | null;
  coverId: number | null;
  isOfficial: boolean;
  tags: { id: number; name: string }[];
};

/** The payloads of the eligible articles among `ids`; an id missing from the map gets no point. */
export async function getArticleDocs(
  pg: Pick<Pool, 'query'>,
  ids: number[]
): Promise<Map<number, ArticlePayload>> {
  if (!ids.length) return new Map();
  const { rows } = await pg.query<Row>(
    `SELECT a.id, a.title, left(a.content, ${CONTENT_READ_CHARS}) AS content, a."nsfwLevel",
       a."publishedAt", a."userId", u.username, a."coverId", a."isOfficial",
       COALESCE((SELECT json_agg(json_build_object('id', t.id, 'name', t.name) ORDER BY t.name)
         FROM "TagsOnArticle" ta JOIN "Tag" t ON t.id = ta."tagId"
         WHERE ta."articleId" = a.id), '[]') AS tags
     FROM "Article" a JOIN "User" u ON u.id = a."userId"
     WHERE a.id = ANY($1::int[]) AND ${ARTICLE_ELIGIBLE_SQL}`,
    [ids]
  );
  const docs = new Map<number, ArticlePayload>();
  for (const row of rows) {
    const { text, tags, docHash } = articleDocument({
      title: row.title,
      username: row.username,
      tags: row.tags.map((t) => t.name),
      content: row.content,
    });
    docs.set(row.id, {
      title_normalized: normalizeTitle(row.title),
      search_text: text,
      title: row.title,
      tags,
      tagIds: row.tags.map((t) => t.id),
      nsfwLevel: nsfwLevels(row.nsfwLevel),
      publishedAt: new Date(row.publishedAt).toISOString(),
      userId: row.userId,
      username: row.username,
      coverImageId: row.coverId,
      isOfficial: row.isOfficial,
      docHash,
    });
  }
  return docs;
}
