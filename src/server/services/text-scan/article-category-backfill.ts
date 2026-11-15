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

export async function runArticleCategoryBackfill({
  afterId,
  limit,
  concurrency,
  dryRun,
}: {
  afterId: number;
  limit: number;
  concurrency: number;
  dryRun: boolean;
}) {
  // dbWrite: a replica lagging behind an earlier chunk's writes would reselect classified articles.
  const rows = await dbWrite.$queryRawUnsafe<{ id: number }[]>(
    ARTICLE_CATEGORY_BACKFILL_SQL,
    afterId,
    limit
  );
  const ids = rows.map((r) => r.id);
  const nextAfterId = ids.length ? ids[ids.length - 1] : null;
  const summary = (results: { entityId: number; status: ArticleCategoryBackfillStatus }[]) => {
    const byStatus = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    return { dryRun, selected: ids.length, nextAfterId, byStatus, results };
  };

  if (dryRun || !ids.length)
    return summary(ids.map((entityId) => ({ entityId, status: 'dry-run' as const })));

  const profile = getTextScanProfile('Article');
  const hook = profile?.category;
  if (!profile || !hook) throw new Error('Article text-scan profile has no category hook');
  const [config, subjects] = await Promise.all([getTextScanConfig(), profile.load(ids)]);
  const scanCallbackUrl = textScanCallbackUrl();

  const run = pLimit(concurrency);
  const results = await Promise.all(
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
          await logToAxiom({
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
  const result = summary(results);
  await logToAxiom({
    name: 'text-category',
    type: 'info',
    message: 'backfill chunk',
    afterId,
    selected: result.selected,
    nextAfterId,
    ...result.byStatus,
  });
  return result;
}
