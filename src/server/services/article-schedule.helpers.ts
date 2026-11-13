import {
  POST_MAXIMUM_SCHEDULE_MONTHS,
  POST_MINIMUM_SCHEDULE_MINUTES,
  scheduleWindow,
} from '@civitai/shared/post-scheduling';
import { ArticleIngestionStatus, ArticleStatus } from '~/shared/utils/prisma/enums';

/**
 * Why `article` may not be scheduled to go live at `date`, or null when it may. `article` is null
 * for one being created.
 *
 * Only a never-published Draft: an article that has been public keeps its original publishedAt on
 * republish, so a scheduled republish would surface at its old date rather than the chosen one.
 * Same lead time and horizon as a scheduled post.
 */
export function getArticleScheduleError(
  article: { publishedAt: Date | null; status: string } | null,
  date: Date,
  now: Date
): string | null {
  if (article && (article.publishedAt || article.status !== ArticleStatus.Draft))
    return 'Only an article that has never been published can be scheduled';
  const { min, max } = scheduleWindow(now);
  if (date < min)
    return `Schedule date must be at least ${POST_MINIMUM_SCHEDULE_MINUTES} minutes in the future`;
  if (date > max)
    return `Schedule date cannot be more than ${POST_MAXIMUM_SCHEDULE_MONTHS} months in the future`;
  return null;
}

export type ScheduledArticleGoLive = 'publish' | 'process' | 'fail' | 'withdraw';

/**
 * Author standing is re-checked here: it was validated when the schedule was saved and can change
 * before go-live. 'process' leaves publishing to the ingestion recompute, as for a manual publish.
 */
export function getScheduledArticleGoLive(
  ingestion: ArticleIngestionStatus,
  author: { bannedAt: Date | null; muted: boolean; deletedAt: Date | null }
): ScheduledArticleGoLive {
  if (author.bannedAt || author.muted || author.deletedAt) return 'withdraw';
  switch (ingestion) {
    case ArticleIngestionStatus.Scanned:
      return 'publish';
    case ArticleIngestionStatus.Pending:
    case ArticleIngestionStatus.Rescan:
      return 'process';
    case ArticleIngestionStatus.Blocked:
    case ArticleIngestionStatus.Error:
      return 'fail';
  }
}
