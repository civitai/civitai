import { sql } from '@civitai/db/kysely';
import { NsfwLevel } from '@civitai/shared';
import { createCache } from './cache';
import { dbRead } from './db';
import { bounded } from './bounded';
import { getImageReviewCounts } from './image-review.service';
import {
  countImagesPendingIngestion,
  countIngestionErrorImages,
  countMissingMediaImages,
} from './ingestion.service';
import { getImageRatingReviewCount } from './image-rating-review.service';
import { countModeratorArticles } from './articles.service';
import { getArticleRatingReviewCounts } from './article-rating-reviews.service';
import { getReportCounts } from './reports.service';

export type SidebarCounts = Record<string, number>;

const counts = createCache({ name: 'sidebar-counts:v1', fetch: fetchCounts, ttlSeconds: 60 });

export function getSidebarCounts(): Promise<SidebarCounts> {
  return counts.get({});
}

async function fetchCounts(): Promise<SidebarCounts> {
  const [
    modes,
    imageTags,
    imageRatings,
    appeals,
    reported,
    articles,
    articleRatings,
    reports,
    toIngest,
    ingestionErrors,
    missingMedia,
  ] = await Promise.all([
    getImageReviewCounts(),
    // Bitmask predicates must match the TagsOnImageNew_needsReview_idx partial index (bit 9 set, bit 10 clear).
    // The nsfwLevel bound must match the QUEUE's (image-tags.service.ts) — without it, blocked images
    // inflate a badge whose page can never show them, so the count never reaches zero.
    dbRead
      .selectFrom('TagsOnImageNew as toi')
      .innerJoin('Image as i', 'i.id', 'toi.imageId')
      .select((eb) => eb.fn.count('toi.imageId').distinct().as('count'))
      .where(sql<boolean>`((toi.attributes >> 9)::integer & 1) = 1`)
      .where(sql<boolean>`((toi.attributes >> 10)::integer & 1) <> 1`)
      .where('i.nsfwLevel', '<', NsfwLevel.Blocked)
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
    getReportCounts(),
    // Both queues were populated and badgeless — the counts simply had no key. Bounded because
    // neither predicate has an index of its own; see `bounded`.
    bounded(countImagesPendingIngestion),
    bounded(countIngestionErrorImages),
    bounded(countMissingMediaImages),
  ]);
  return {
    ...modes,
    ...reports,
    imageTags: Number(imageTags?.count ?? 0),
    imageRatings,
    appeals: Number(appeals?.count ?? 0),
    reported: Number(reported?.count ?? 0),
    articles,
    articleRatings: articleRatings.Pending,
    ...(toIngest != null ? { toIngest } : {}),
    ...(ingestionErrors != null ? { ingestionErrors } : {}),
    ...(missingMedia != null ? { missingMedia } : {}),
  };
}
