import pLimit from 'p-limit';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { ARTICLE_CATEGORY_BACKFILL_SQL } from '~/server/services/text-scan/article-category-backfill-query';
import type { TextCategorySubmitOutcome } from '~/server/services/text-scan/category';
import { submitTextCategoryScan } from '~/server/services/text-scan/category';
import { getTextScanProfile } from '~/server/services/text-scan/profiles';
import { getTextScanConfig } from '~/server/services/text-scan/prompt';
import { textScanCallbackUrl } from '~/server/services/text-scan/submit';

export type ArticleCategoryBackfillStatus =
  | 'dry-run'
  | 'gone'
  | 'not-public'
  | TextCategorySubmitOutcome;

type ArticleCategoryResult = { entityId: number; status: ArticleCategoryBackfillStatus };

export function countByStatus(results: ArticleCategoryResult[]) {
  return results.reduce<Record<string, number>>((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});
}

export async function selectUncategorizedArticles({
  afterId,
  limit,
  includeMature,
  publishedBefore = new Date(),
  client = dbWrite,
}: {
  afterId: number;
  limit: number;
  includeMature: boolean;
  publishedBefore?: Date;
  client?: Pick<typeof dbWrite, '$queryRawUnsafe'>;
}) {
  const rows = await client.$queryRawUnsafe<{ id: number }[]>(
    ARTICLE_CATEGORY_BACKFILL_SQL,
    afterId,
    limit,
    includeMature,
    publishedBefore
  );
  return rows.map((r) => r.id);
}

/** One category call per public article; each submitted one is billed. */
export async function submitArticleCategoryCalls(
  ids: number[],
  concurrency: number
): Promise<ArticleCategoryResult[]> {
  const profile = getTextScanProfile('Article');
  const hook = profile?.category;
  if (!profile || !hook) throw new Error('Article text-scan profile has no category hook');
  const [config, subjects] = await Promise.all([getTextScanConfig(), profile.load(ids)]);
  const scanCallbackUrl = textScanCallbackUrl();

  const run = pLimit(concurrency);
  return Promise.all(
    ids.map((entityId) =>
      run(async () => {
        const subject = subjects.get(entityId);
        if (!subject) return { entityId, status: 'gone' as const };
        if (subject.notPublic) return { entityId, status: 'not-public' as const };
        try {
          const status = await submitTextCategoryScan({
            entityType: 'Article',
            entityId,
            subject,
            hook,
            model: config.model,
            maxInputChars: config.maxInputChars,
            scanCallbackUrl,
          });
          return { entityId, status };
        } catch (e) {
          logToAxiom({
            name: 'text-category',
            type: 'error',
            message: 'backfill submit threw',
            entityId,
            error: (e as Error).message,
          });
          return { entityId, status: 'failed' as const };
        }
      })
    )
  );
}

export async function runArticleCategoryBackfill({
  afterId,
  limit,
  concurrency,
  dryRun,
  includeMature,
}: {
  afterId: number;
  limit: number;
  concurrency: number;
  dryRun: boolean;
  includeMature: boolean;
}) {
  // dbWrite: a replica lagging behind an earlier chunk's writes would reselect classified articles.
  const ids = await selectUncategorizedArticles({ afterId, limit, includeMature });
  const nextAfterId = ids.length ? ids[ids.length - 1] : null;
  const summary = (results: ArticleCategoryResult[]) => ({
    dryRun,
    includeMature,
    selected: ids.length,
    nextAfterId,
    byStatus: countByStatus(results),
    results,
  });

  if (dryRun || !ids.length)
    return summary(ids.map((entityId) => ({ entityId, status: 'dry-run' as const })));

  const result = summary(await submitArticleCategoryCalls(ids, concurrency));
  // `failed` is an existing Axiom field; the other statuses are not, so they go under payload.
  const { failed, ...otherStatuses } = result.byStatus;
  logToAxiom({
    name: 'text-category',
    type: 'info',
    message: 'backfill chunk',
    failed,
    payload: {
      afterId,
      includeMature,
      selected: result.selected,
      nextAfterId,
      ...otherStatuses,
    },
  });
  return result;
}
