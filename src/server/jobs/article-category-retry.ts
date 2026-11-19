import { dbRead } from '~/server/db/client';
import { createJob } from '~/server/jobs/job';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import {
  countByStatus,
  selectUncategorizedArticles,
  submitArticleCategoryCalls,
} from '~/server/services/text-scan/article-category-backfill';
import { getTextScanMode, isTextScanEnabled } from '~/server/services/text-scan/mode';

// The live call's callback lands within minutes, so a NULL this long after the last publish or edit
// is a call that failed (or, outside the rollout, one never sent: those are skipped).
const SETTLE_MS = 60 * 60 * 1000;
export const MAX_CATEGORY_RETRIES = 3;
// Outlives the 30-day selection window, so a capped article is not retried again.
const RETRIES_TTL_SECONDS = 31 * 24 * 60 * 60;
const PAGE_SIZE = 200;
// A bound, so a paging bug ends the run instead of looping.
const MAX_PAGES = 50;
export const MAX_SUBMITS_PER_RUN = 50;
const CONCURRENCY = 2;

/** The attempt this call would be, or null when Redis fails: a call is never billed uncounted. */
async function recordRetry(articleId: number) {
  const key = `${REDIS_KEYS.TEXT_SCAN.CATEGORY_RETRIES}:${articleId}` as const;
  try {
    const attempts = await redis.incrBy(key, 1);
    await redis.expire(key, RETRIES_TTL_SECONDS);
    return attempts;
  } catch {
    return null;
  }
}

/**
 * Resends the category call for articles the Story Writers board could score that are still
 * unclassified an hour after publish. The live call has no retry of its own: a failed submit or
 * workflow leaves the category NULL.
 */
const defaultDeps = {
  isEnabled: isTextScanEnabled,
  modeOf: getTextScanMode,
  select: selectUncategorizedArticles,
  submit: submitArticleCategoryCalls,
};

export async function retryArticleCategories(now = new Date(), deps = defaultDeps) {
  const { isEnabled, modeOf, select, submit } = deps;
  if (!(await isEnabled())) return { disabled: true };
  const publishedBefore = new Date(now.getTime() - SETTLE_MS);
  const due: number[] = [];
  let selected = 0;
  let capped = 0;
  let uncounted = 0;
  let outOfRollout = 0;
  let afterId = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const ids = await select({
      afterId,
      limit: PAGE_SIZE,
      includeMature: true,
      publishedBefore,
      client: dbRead,
    });
    selected += ids.length;
    for (const id of ids) {
      if (due.length >= MAX_SUBMITS_PER_RUN) break;
      // The live path sends no category call for an article its rollout leaves off.
      if ((await modeOf('Article', id)) === 'off') {
        outOfRollout++;
        continue;
      }
      const attempts = await recordRetry(id);
      if (attempts === null) uncounted++;
      else if (attempts <= MAX_CATEGORY_RETRIES) due.push(id);
      else {
        capped++;
        if (attempts === MAX_CATEGORY_RETRIES + 1)
          logToAxiom({
            name: 'text-category',
            type: 'warning',
            message: 'retry cap reached',
            entityType: 'Article',
            entityId: id,
          });
      }
    }
    if (ids.length < PAGE_SIZE || due.length >= MAX_SUBMITS_PER_RUN) break;
    afterId = ids[ids.length - 1];
  }

  const byStatus = countByStatus(due.length ? await submit(due, CONCURRENCY) : []);
  const result = { selected, capped, uncounted, outOfRollout, byStatus };
  // `failed` is an existing Axiom field; the other counts are not, so they go under payload.
  const { failed, ...otherStatuses } = byStatus;
  logToAxiom({
    name: 'text-category',
    type: 'info',
    message: 'retry run',
    failed,
    payload: { selected, capped, uncounted, outOfRollout, ...otherStatuses },
  });
  return result;
}

export const articleCategoryRetryJob = createJob('article-category-retry', '23 * * * *', () =>
  retryArticleCategories()
);
