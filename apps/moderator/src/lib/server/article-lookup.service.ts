import type { ArticleStatus } from '@civitai/db-schema/enums';
import { dbRead } from './db';
import { isInt4Id } from './users.service';

// Retool's Article Lookup (FindArticle + ArticleMetrics). Investigation only — both reads go to the
// replica, so looking an article up never touches the primary.
//
// Retool selected `Article.*`. `content` is the full article body: it would dominate the payload and a
// moderator reading an article reads it on the site, not in a table. The fields here are the ones an
// article is acted on by — visibility, moderation state, ingestion, and who wrote it.

export type ArticleRow = {
  id: number;
  title: string;
  createdAt: Date | null;
  updatedAt: Date | null;
  publishedAt: Date | null;
  status: ArticleStatus;
  availability: string;
  unlisted: boolean;
  nsfw: boolean;
  tosViolation: boolean;
  nsfwLevel: number;
  userNsfwLevel: number;
  moderatorNsfwLevel: number | null;
  ingestion: string;
  contentScannedAt: Date | null;
  scanRequestedAt: Date | null;
  lockedProperties: string[];
  metadata: unknown;
  coverId: number | null;
  /** The pre-`coverId` cover, held as a URL string. 7 of 26,505 articles have only this one. */
  cover: string | null;
  moderatorNsfwLevelBasis: number | null;
  userId: number;
  username: string | null;
  userBannedAt: Date | null;
  /** Characters, not the body itself — enough to tell a stub from a real article. */
  contentLength: number;
};

/** Retool took a raw id. A moderator arriving from a report has a URL, so both resolve — matching
 *  Image Lookup, where pasting the link is already the established behaviour. */
export function resolveArticleId(term: string): number | null {
  const value = term.trim();
  if (!value) return null;

  const digits = /^\d+$/.test(value) ? value : value.match(/\/articles\/(\d+)/)?.[1];
  if (!digits) return null;

  // `Article.id` is a Postgres integer: a larger value ERRORS the comparison rather than missing, so a
  // double-pasted id would 500 the page instead of finding nothing.
  const id = Number(digits);
  return isInt4Id(id) ? id : null;
}

export async function getArticle(articleId: number): Promise<ArticleRow | null> {
  const row = await dbRead
    .selectFrom('Article as a')
    .leftJoin('User as u', 'u.id', 'a.userId')
    .select((eb) => [
      'a.id',
      'a.title',
      'a.createdAt',
      'a.updatedAt',
      'a.publishedAt',
      'a.status',
      'a.availability',
      'a.unlisted',
      'a.nsfw',
      'a.tosViolation',
      // The cover image drives the article's effective nsfwLevel, which is this page's headline badge —
      // so "which image is the cover" is a question the page invites and could not answer.
      'a.coverId',
      'a.cover',
      'a.nsfwLevel',
      'a.userNsfwLevel',
      'a.moderatorNsfwLevel',
      'a.moderatorNsfwLevelBasis',
      'a.ingestion',
      'a.contentScannedAt',
      'a.scanRequestedAt',
      'a.lockedProperties',
      // `Json?` with no schema documentation, so what lives here is unknown rather than known-empty.
      // Rendered raw when non-empty: cheaper than guessing, and it stops the question recurring.
      'a.metadata',
      'a.userId',
      'u.username',
      'u.bannedAt as userBannedAt',
      eb.fn<number>('length', ['a.content']).as('contentLength'),
    ])
    .where('a.id', '=', articleId)
    .executeTakeFirst();

  return row ? (row as unknown as ArticleRow) : null;
}

// One row per timeframe (Day/Week/Month/Year/AllTime), which is the shape Retool showed as a table.
export type ArticleMetricRow = {
  timeframe: string;
  viewCount: number;
  likeCount: number;
  dislikeCount: number;
  laughCount: number;
  cryCount: number;
  heartCount: number;
  commentCount: number;
  favoriteCount: number;
  collectedCount: number;
  tippedCount: number;
  tippedAmountCount: number;
  hideCount: number;
  updatedAt: Date;
};

// AllTime first, then descending window size — Retool returned them in whatever order the table
// produced, and a moderator reads the all-time figure first.
const TIMEFRAME_ORDER = ['AllTime', 'Year', 'Month', 'Week', 'Day'];

export async function getArticleMetrics(articleId: number): Promise<ArticleMetricRow[]> {
  const rows = await dbRead
    .selectFrom('ArticleMetric')
    .select([
      'timeframe',
      'viewCount',
      'likeCount',
      'dislikeCount',
      'laughCount',
      'cryCount',
      'heartCount',
      'commentCount',
      'favoriteCount',
      'collectedCount',
      'tippedCount',
      'tippedAmountCount',
      'hideCount',
      'updatedAt',
    ])
    .where('articleId', '=', articleId)
    .execute();

  return (rows as unknown as ArticleMetricRow[]).sort(
    (a, b) => TIMEFRAME_ORDER.indexOf(a.timeframe) - TIMEFRAME_ORDER.indexOf(b.timeframe)
  );
}

export type ArticleLookupResult = { article: ArticleRow; metrics: ArticleMetricRow[] };

export async function getArticleLookup(articleId: number): Promise<ArticleLookupResult | null> {
  const [article, metrics] = await Promise.all([
    getArticle(articleId),
    getArticleMetrics(articleId),
  ]);
  return article ? { article, metrics } : null;
}
