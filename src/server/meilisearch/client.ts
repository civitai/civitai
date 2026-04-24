import type { EnqueuedTask, DocumentsQuery, ResourceResults } from 'meilisearch';
import { MeiliSearch } from 'meilisearch';
import { env } from '~/env/server';
import { createLogger } from '~/utils/logging';
import { sleep } from '~/server/utils/errorHandling';
import type { JobContext } from '~/server/jobs/job';

const log = createLogger('search', 'green');

const shouldConnectToSearch = !env.IS_BUILD && !!env.SEARCH_HOST && !!env.SEARCH_API_KEY;
export const searchClient = shouldConnectToSearch
  ? new MeiliSearch({
      host: env.SEARCH_HOST as string,
      apiKey: env.SEARCH_API_KEY,
    })
  : null;

const shouldConnectToMetricsSearch =
  !env.IS_BUILD && !!env.METRICS_SEARCH_HOST && !!env.METRICS_SEARCH_API_KEY;
export const metricsSearchClient = shouldConnectToMetricsSearch
  ? new MeiliSearch({
      host: env.METRICS_SEARCH_HOST as string,
      apiKey: env.METRICS_SEARCH_API_KEY,
    })
  : null;

/**
 * Fetch documents via a raw HTTP call that honors an AbortSignal. The
 * meilisearch-js client we're on (<=0.34) doesn't expose signal on
 * getDocuments, so we hit the /documents/fetch endpoint directly when a
 * cancellable request is needed (e.g. the image feed's slow-fetch path).
 */
export async function fetchDocumentsAbortable<T>(
  indexName: string,
  params: DocumentsQuery<T>,
  options: { host: string; apiKey?: string; signal?: AbortSignal }
): Promise<ResourceResults<T[]>> {
  const { host, apiKey, signal } = options;
  const res = await fetch(`${host}/indexes/${indexName}/documents/fetch`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(params),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Meilisearch fetch failed (${res.status}): ${text}`);
  }
  return (await res.json()) as ResourceResults<T[]>;
}

const RETRY_LIMIT = 5;
export async function updateDocs({
  indexName,
  documents,
  batchSize = 1000,
  jobContext,
  client = searchClient,
}: {
  indexName: string;
  documents: any[];
  batchSize?: number;
  jobContext?: JobContext;
  client?: MeiliSearch | null;
}): Promise<EnqueuedTask[]> {
  if (!client) return [];

  let retryCount = 0;
  while (true) {
    try {
      const updates = [];
      for (let i = 0; i < documents.length; i += batchSize) {
        jobContext?.checkIfCanceled();
        const batch = documents.slice(i, i + batchSize);
        try {
          updates.push(await client.index(indexName).updateDocuments(batch));
        } catch (e) {
          console.error(
            'updateDocs :: Failed on batch',
            i,
            'of',
            documents.length,
            'for index',
            indexName
          );

          throw e;
        }
      }
      return updates;
    } catch (err) {
      retryCount++;
      if (retryCount >= RETRY_LIMIT) throw err;
      console.error(
        `updateDocs :: error updating docs for index ${indexName}. Retry ${retryCount}`,
        err
      );

      await sleep(5000 * (1 + retryCount));
    }
  }
}
