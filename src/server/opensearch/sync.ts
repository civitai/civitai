import { openSearchClient, bulkOperation, deleteDocsById, deleteDocsByQuery } from './client';
import { isFlipt } from '~/server/flipt/client';
import type { JobContext } from '~/server/jobs/job';

export async function syncToOpenSearch({
  operation,
  indexName,
  documents,
  batchSize,
  jobContext,
}: {
  operation: 'index' | 'update' | 'delete';
  indexName: string;
  documents: Array<{ id: number; [key: string]: unknown }>;
  batchSize?: number;
  jobContext?: JobContext;
}): Promise<void> {
  if (!openSearchClient) return;
  if (!(await isFlipt('feed-opensearch'))) return;

  if (operation === 'delete') {
    await deleteDocsById({ indexName, ids: documents.map((d) => d.id) });
  } else {
    await bulkOperation({ mode: operation, indexName, documents, batchSize, jobContext });
  }
}

export async function syncDeleteByQuery({
  indexName,
  query,
}: {
  indexName: string;
  query: Record<string, unknown>;
}): Promise<void> {
  if (!openSearchClient) return;
  if (!(await isFlipt('feed-opensearch'))) return;
  await deleteDocsByQuery({ indexName, query });
}
