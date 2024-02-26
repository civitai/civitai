import { EnqueuedTask, MeiliSearch } from 'meilisearch';
import { env } from '~/env/server.mjs';
import { createLogger } from '~/utils/logging';
import { sleep } from '~/server/utils/errorHandling';
import { JobContext } from '~/server/jobs/job';

const log = createLogger('search', 'green');

const shouldConnect = !!env.SEARCH_HOST && !!env.SEARCH_API_KEY;
export const client = shouldConnect
  ? new MeiliSearch({
      host: env.SEARCH_HOST as string,
      apiKey: env.SEARCH_API_KEY,
    })
  : null;

const RETRY_LIMIT = 5;
export async function updateDocs({
  indexName,
  documents,
  batchSize = 1000,
  jobContext,
}: {
  indexName: string;
  documents: any[];
  batchSize?: number;
  jobContext?: JobContext;
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
