import { chunk } from 'lodash-es';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { articlesSearchIndex } from '~/server/search-index';
import { modelImageIdsSql } from '~/server/services/collection-media-index';

/** The articles whose cover or banner is an image on a post of this model. */
export async function getArticleIdsCoveredByModel(modelId: number) {
  const modelImagesSql = modelImageIdsSql(modelId);
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT a.id FROM "Article" a WHERE a."coverId" IN (${modelImagesSql})
    UNION
    SELECT a.id FROM "Article" a WHERE a."bannerId" IN (${modelImagesSql})
  `;
  return rows.map((row) => Number(row.id));
}

/**
 * Rebuild the search documents of the articles whose cover or banner is on this model, after a
 * change to what the model may show (its mode, or a minor or SFW-only gallery level): the document
 * drops a cover its model withholds. Never throws; a failure is logged and the documents catch up
 * on their next update.
 */
export async function queueModelArticlesReindex(modelId: number) {
  try {
    const ids = await getArticleIdsCoveredByModel(modelId);
    for (const batch of chunk(ids, 500))
      await articlesSearchIndex.queueUpdate(
        batch.map((id) => ({ id, action: SearchIndexUpdateQueueAction.Update })),
        { reason: 'model-hold' }
      );
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'model-articles-index-enqueue-failed',
      message: error instanceof Error ? error.message : 'unknown',
      modelId,
    });
  }
}
