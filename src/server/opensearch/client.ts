import { Client } from '@opensearch-project/opensearch';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';
import { sleep } from '~/server/utils/errorHandling';
import type { JobContext } from '~/server/jobs/job';

const log = createLogger('opensearch', 'cyan');

const shouldConnect = !env.IS_BUILD && !!env.OPENSEARCH_HOST;
export const openSearchClient = shouldConnect
  ? new Client({
      node: env.OPENSEARCH_HOST as string,
      ...(env.OPENSEARCH_API_KEY
        ? {
            headers: {
              Authorization: `Bearer ${env.OPENSEARCH_API_KEY}`,
            },
          }
        : {}),
      ssl: { rejectUnauthorized: env.OPENSEARCH_SSL_VERIFY !== 'false' },
    })
  : null;

const RETRY_LIMIT = 5;

export async function bulkOperation({
  mode,
  indexName,
  documents,
  batchSize = 1000,
  jobContext,
}: {
  mode: 'index' | 'update';
  indexName: string;
  documents: Array<{ id: number; [key: string]: unknown }>;
  batchSize?: number;
  jobContext?: JobContext;
}): Promise<void> {
  if (!openSearchClient) return;

  for (let i = 0; i < documents.length; i += batchSize) {
    jobContext?.checkIfCanceled();
    const batch = documents.slice(i, i + batchSize);

    let retryCount = 0;
    while (true) {
      try {
        const body =
          mode === 'index'
            ? batch.flatMap((doc) => [
                { index: { _index: indexName, _id: String(doc.id) } },
                doc,
              ])
            : batch.flatMap((doc) => {
                const { id, ...fields } = doc;
                return [{ update: { _index: indexName, _id: String(id) } }, { doc: fields }];
              });

        const response = await openSearchClient.bulk({ body, refresh: false });

        if (response.body.errors) {
          const errorItems = response.body.items.filter(
            (item: Record<string, { error?: unknown }>) => item[mode]?.error
          );
          console.error(
            `bulkOperation(${mode}) :: Errors in batch`,
            i,
            'of',
            documents.length,
            'for index',
            indexName,
            JSON.stringify(errorItems.slice(0, 3))
          );
        }
        break;
      } catch (err) {
        retryCount++;
        if (retryCount >= RETRY_LIMIT) throw err;
        console.error(
          `bulkOperation(${mode}) :: error for index ${indexName}, batch ${i}. Retry ${retryCount}`,
          err
        );
        await sleep(5000 * (1 + retryCount));
      }
    }
  }
}

export async function bulkIndexDocs(args: {
  indexName: string;
  documents: Array<{ id: number; [key: string]: unknown }>;
  batchSize?: number;
  jobContext?: JobContext;
}): Promise<void> {
  return bulkOperation({ mode: 'index', ...args });
}

export async function bulkUpdateDocs(args: {
  indexName: string;
  documents: Array<{ id: number; [key: string]: unknown }>;
  batchSize?: number;
  jobContext?: JobContext;
}): Promise<void> {
  return bulkOperation({ mode: 'update', ...args });
}

export async function deleteDocsById({
  indexName,
  ids,
}: {
  indexName: string;
  ids: number[];
}): Promise<void> {
  if (!openSearchClient || ids.length === 0) return;

  const body = ids.map((id) => ({
    delete: { _index: indexName, _id: String(id) },
  }));

  await openSearchClient.bulk({ body, refresh: false });
}

export async function deleteDocsByQuery({
  indexName,
  query,
}: {
  indexName: string;
  query: Record<string, unknown>;
}): Promise<void> {
  if (!openSearchClient) return;

  await openSearchClient.deleteByQuery({
    index: indexName,
    body: { query },
  });
}
