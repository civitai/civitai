import { sql } from '@civitai/db/kysely';
import { dbRead } from './db';
import { getImageReviewCounts } from './image-review.service';
import { getImageRatingReviewCount } from './image-rating-review.service';
import { countModeratorArticles } from './articles.service';
import { getArticleRatingReviewCounts } from './article-rating-reviews.service';

export type SidebarCounts = Record<string, number>;

const TTL_MS = 60_000;
let cache: { at: number; value: Promise<SidebarCounts> } | null = null;

export function getSidebarCounts(now = Date.now()): Promise<SidebarCounts> {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = fetchCounts();
  cache = { at: now, value };
  // Don't cache a rejection — let the next navigation retry.
  value.catch(() => {
    if (cache?.value === value) cache = null;
  });
  return value;
}

async function fetchCounts(): Promise<SidebarCounts> {
  const [modes, imageTags, imageRatings, appeals, reported, articles, articleRatings] =
    await Promise.all([
      getImageReviewCounts(),
      // Bitmask predicates must match the TagsOnImageNew_needsReview_idx partial index (bit 9 set, bit 10 clear).
      dbRead
        .selectFrom('TagsOnImageNew')
        .select((eb) => eb.fn.count('imageId').distinct().as('count'))
        .where(sql<boolean>`((attributes >> 9)::integer & 1) = 1`)
        .where(sql<boolean>`((attributes >> 10)::integer & 1) <> 1`)
        .executeTakeFirst(),
      getImageRatingReviewCount(),
      dbRead
        .selectFrom('Image')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('needsReview', '=', 'appeal')
        .executeTakeFirst(),
      // Count per image, not per report. Rides Report_pending_id_idx (~270ms, streamed off render).
      dbRead
        .selectFrom('Report as r')
        .innerJoin('ImageReport as ir', 'ir.reportId', 'r.id')
        .select((eb) => eb.fn.count('ir.imageId').distinct().as('count'))
        .where('r.status', '=', 'Pending')
        .executeTakeFirst(),
      countModeratorArticles(),
      getArticleRatingReviewCounts(),
    ]);
  return {
    ...modes,
    imageTags: Number(imageTags?.count ?? 0),
    imageRatings,
    appeals: Number(appeals?.count ?? 0),
    reported: Number(reported?.count ?? 0),
    articles,
    articleRatings: articleRatings.Pending,
  };
}
