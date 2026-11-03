import { env } from '~/env/server';
import type { OpenSearchClient } from '~/server/search/opensearch/opensearch-client';
import {
  createOpenSearchClient,
  fetchTransport,
} from '~/server/search/opensearch/opensearch-client';

let client: OpenSearchClient | null | undefined;

/** The OpenSearch client, or `null` where OpenSearch is not configured. */
export function getOpenSearchClient(): OpenSearchClient | null {
  if (client !== undefined) return client;
  client = env.OPENSEARCH_URL
    ? createOpenSearchClient(
        fetchTransport({
          url: env.OPENSEARCH_URL,
          username: env.OPENSEARCH_USERNAME,
          password: env.OPENSEARCH_PASSWORD,
          timeoutMs: 5_000,
        })
      )
    : null;
  return client;
}
