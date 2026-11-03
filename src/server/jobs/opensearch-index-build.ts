import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { redisCheckpointStore } from '~/server/search/opensearch/checkpoint-store';
import { buildIndex, rollbackAlias } from '~/server/search/opensearch/index-build';
import { MODELS_INDEX_ALIAS } from '~/server/search/opensearch/indexes';
import {
  createModelsIndexSource,
  modelsIndexDefinition,
} from '~/server/search/opensearch/models-index-source';
import {
  createOpenSearchClient,
  fetchTransport,
} from '~/server/search/opensearch/opensearch-client';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

/**
 * Rebuilds the OpenSearch models index from the database into a new index and swaps the `models`
 * alias to it (src/server/search/opensearch/index-build.ts). Manual only. Run it again after a
 * failure or a cancel and it resumes from its checkpoint.
 */
function buildClient() {
  if (!env.OPENSEARCH_URL) throw new Error('OPENSEARCH_URL is not set');
  return createOpenSearchClient(
    fetchTransport({
      url: env.OPENSEARCH_URL,
      username: env.OPENSEARCH_USERNAME,
      password: env.OPENSEARCH_PASSWORD,
      timeoutMs: 120_000,
    })
  );
}

export const opensearchModelsBuildJob = createJob(
  'opensearch-models-build',
  UNRUNNABLE_JOB_CRON,
  async (jobContext) => {
    const client = buildClient();
    const controller = new AbortController();
    jobContext.on('cancel', async () => controller.abort());

    const report = await buildIndex({
      alias: MODELS_INDEX_ALIAS,
      client,
      source: createModelsIndexSource({ db: dbRead }),
      definition: modelsIndexDefinition,
      checkpoints: redisCheckpointStore,
      batchSize: 500,
      concurrency: 8,
      signal: controller.signal,
      logger: (message, data) =>
        logToAxiom({ type: 'info', name: 'opensearch-index-build', message, ...data }).catch(
          () => undefined
        ),
    });
    return report;
  },
  // A full build takes about an hour; the lock outlives it with room to spare.
  { lockExpiration: 180 * 60 }
);

/** Points the `models` alias back at the previous build, which every build keeps. Manual only. */
export const opensearchModelsRollbackJob = createJob(
  'opensearch-models-rollback',
  UNRUNNABLE_JOB_CRON,
  async () => rollbackAlias(buildClient(), MODELS_INDEX_ALIAS)
);
