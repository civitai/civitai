import { registerCounterWithLabels } from '@civitai/telemetry/client';
import { logToAxiom } from '~/server/logging/client';
import type { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { redisCheckpointStore } from '~/server/search/opensearch/checkpoint-store';
import { getOpenSearchClient } from '~/server/search/opensearch/client';
import { activeBuildIndex } from '~/server/search/opensearch/index-build';
import { MODELS_INDEX_ALIAS } from '~/server/search/opensearch/indexes';
import type { BulkOperation, OpenSearchClient } from '~/server/search/opensearch/opensearch-client';

type ModelRecord = Omit<ModelSearchIndexRecord, 'images'>;
type TransformedModels = {
  indexReadyRecords: unknown[];
  indexRecordsWithImages: { id: number; images: unknown[] }[];
};

/**
 * One model's OpenSearch document: the Meilisearch record and its images merged (Meilisearch
 * receives them as two partial writes and merges them), plus `ranking`, the real numbers ranking
 * and sorting use. `ranking` and the withheld attributes are indexed but never stored (see the
 * mapping's `_source.excludes`), so no response can return them.
 */
export function toModelDocument(record: ModelRecord, images: unknown[]) {
  const metrics = (record.metrics ?? {}) as Record<string, number | null | undefined>;
  return {
    ...record,
    images,
    ranking: {
      thumbsUpCount: metrics.thumbsUpCount ?? 0,
      commentCount: metrics.commentCount ?? 0,
      collectedCount: metrics.collectedCount ?? 0,
      downloadCount: record.sortMetrics?.downloadCount ?? 0,
      tippedAmountCount: record.sortMetrics?.tippedAmountCount ?? 0,
    },
  };
}

/** The OpenSearch documents for a models transform's output, by model id. */
export function toModelDocuments(transformed: TransformedModels) {
  const imagesByModel = new Map(transformed.indexRecordsWithImages.map((r) => [r.id, r.images]));
  return new Map(
    (transformed.indexReadyRecords as ModelRecord[]).map((record) => [
      record.id,
      toModelDocument(record, imagesByModel.get(record.id) ?? []),
    ])
  );
}

const mirrorFailures = registerCounterWithLabels({
  name: 'opensearch_mirror_failures_total',
  help:
    'Live models-index writes the OpenSearch mirror could not apply (action=index|delete). The ' +
    'Meilisearch write is unaffected; OpenSearch holds the stale document until the next write ' +
    'or rebuild, so a rising rate skews the engine comparison.',
  labelNames: ['action'] as const,
});

// Resolving the targets costs an alias lookup and a Redis read; live writes arrive every few
// seconds, and a build or swap that is up to this stale only delays when writes follow it.
const TARGETS_TTL_MS = 30_000;
let cachedTargets: { at: number; indexes: string[] } | null = null;

/**
 * The concrete indexes live writes go to: the one the alias serves and, while a build runs, the one
 * being built. Never the alias name itself — writing to a missing alias would make OpenSearch
 * create an index of that name with a guessed mapping.
 */
async function targets(client: OpenSearchClient) {
  if (cachedTargets && Date.now() - cachedTargets.at < TARGETS_TTL_MS) return cachedTargets.indexes;
  const [serving, building] = await Promise.all([
    client.aliasTargets(MODELS_INDEX_ALIAS),
    activeBuildIndex(MODELS_INDEX_ALIAS, redisCheckpointStore),
  ]);
  const indexes = [...new Set([...serving, ...(building ? [building] : [])])];
  cachedTargets = { at: Date.now(), indexes };
  return indexes;
}

async function mirror(action: 'index' | 'delete', operations: BulkOperation[]) {
  const client = getOpenSearchClient();
  if (!client || !operations.length) return;
  try {
    for (const index of await targets(client)) {
      const result = await client.bulk(index, operations);
      const failed = result.rejected.length + result.retryable.length;
      if (failed) mirrorFailures.inc({ action }, failed);
    }
  } catch (error) {
    mirrorFailures.inc({ action }, operations.length);
    logToAxiom({
      type: 'error',
      name: 'opensearch-mirror',
      message: `Could not mirror models ${action} to OpenSearch`,
      cause: (error as Error).message,
      count: operations.length,
    }).catch(() => undefined);
  }
}

/** Writes the documents the models sync just wrote to Meilisearch to OpenSearch as well. */
export function mirrorModelDocuments(transformed: TransformedModels) {
  const operations: BulkOperation[] = [...toModelDocuments(transformed)].map(([id, document]) => ({
    action: 'index',
    id,
    document,
  }));
  return mirror('index', operations);
}

/** Removes the models the sync just removed from Meilisearch from OpenSearch as well. */
export function mirrorModelDeletes(ids: number[]) {
  return mirror(
    'delete',
    ids.map((id) => ({ action: 'delete', id }))
  );
}
