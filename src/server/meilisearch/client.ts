import { EnqueuedTask, MeiliSearch } from 'meilisearch';
import { env } from '~/env/server.mjs';
import { createLogger } from '~/utils/logging';

const log = createLogger('search', 'green');

const shouldConnect = !!env.SEARCH_HOST && !!env.SEARCH_API_KEY;
export const client = shouldConnect
  ? new MeiliSearch({
      host: env.SEARCH_HOST as string,
      apiKey: env.SEARCH_API_KEY,
    })
  : null;

const RETRY_LIMIT = 3;
export async function updateDocs({
  indexName,
  documents,
  batchSize = 1000,
}: {
  indexName: string;
  documents: any[];
  batchSize?: number;
}): Promise<EnqueuedTask[]> {
  if (!client) return [];

  let retryCount = 0;
  while (true) {
    try {
      const results = await client.index(indexName).updateDocumentsInBatches(documents, batchSize);
      return results;
    } catch (err) {
      retryCount++;
      if (retryCount >= RETRY_LIMIT) throw err;
    }
  }
}
