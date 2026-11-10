import { config } from '@/config';
import type { Domain, DomainRef } from '../domain/sync';
import { articleVectorStore } from './collection';
import { getArticleDocs, type ArticlePayload } from './source';

export const ARTICLE_TOPICS = ['postgres.Article', 'postgres.TagsOnArticle'];

/**
 * The article a CDC message touches. A ban changes no article row, so a banned owner's points
 * stay until the article next changes: the site has to re-check eligibility on what it shows.
 */
export function articleRefFromEvent(topic: string, value: unknown): DomainRef | null {
  const event = value as {
    op?: string;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  if (!event || event.op === 'r') return null;
  const row = event.after ?? event.before;
  if (!row) return null;
  const id = topic === 'postgres.Article' ? row.id : row.articleId;
  return typeof id === 'number' && id > 0 ? { id } : null;
}

export const articleDomain: Domain<ArticlePayload> = {
  name: 'article',
  table: 'Article',
  getDocs: getArticleDocs,
  topics: ARTICLE_TOPICS,
  refFromEvent: articleRefFromEvent,
  cdcTables: ['public.Article', 'public.TagsOnArticle'],
  outboxEntity: 'Article',
  store: articleVectorStore,
  alias: () => config.vectorSync.articleAlias,
};
