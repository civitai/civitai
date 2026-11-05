import { SearchError } from './errors';

/** What produced a collection's vectors; written by the event-engine vector sync. */
export type ModelStamp = {
  model?: string;
  dimensions?: number;
  modelRevision?: string;
  profile?: string;
};

export type QdrantFilter = { must: unknown[]; must_not: unknown[] };

export type VectorIndex = {
  stamp(): Promise<ModelStamp>;
  /** Ranked point ids for a query vector, or for the vector of an existing point. */
  query(args: {
    query: number[] | number;
    filter: QdrantFilter;
    offset: number;
    limit: number;
  }): Promise<number[]>;
};

const STAMP_TTL_MS = 5 * 60 * 1000;
// Vectors, graph and payload indexes live on disk: a filter shape Qdrant has not served recently can
// take 10 s on its first query, then well under 1 s.
export const QDRANT_TIMEOUT_MS = 20_000;

/** A Qdrant collection (or alias) over REST. Reads only. */
export function createQdrantIndex({
  url,
  apiKey,
  collection,
  fetch: fetchImpl = fetch,
}: {
  url: string;
  apiKey?: string;
  collection: string;
  fetch?: typeof fetch;
}): VectorIndex {
  const base = `${url.replace(/\/+$/, '')}/collections/${collection}`;

  async function request<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(apiKey ? { 'api-key': apiKey } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(QDRANT_TIMEOUT_MS),
    }).catch((err) => {
      throw new SearchError(502, `Vector index unreachable: ${String(err)}`);
    });
    // A "more like this" point that is not in the index.
    if (res.status === 404 && path) throw new SearchError(404, 'Not in the index');
    if (!res.ok) throw new SearchError(502, `Vector index error (${res.status})`);
    const { result } = (await res.json()) as { result: T };
    return result;
  }

  let cached: { stamp: ModelStamp; at: number } | undefined;

  return {
    async stamp() {
      if (cached && Date.now() - cached.at < STAMP_TTL_MS) return cached.stamp;
      const info = await request<{ config: { metadata?: ModelStamp } }>('');
      cached = { stamp: info.config.metadata ?? {}, at: Date.now() };
      return cached.stamp;
    },
    async query({ query, filter, offset, limit }) {
      const { points } = await request<{ points: { id: number | string }[] }>('/points/query', {
        query,
        filter,
        offset,
        limit,
        // The index keeps int8-quantized vectors in RAM; rescoring reads the originals for the top.
        params: { quantization: { rescore: true, oversampling: 2 } },
        with_payload: false,
      });
      return points.map((p) => Number(p.id));
    },
  };
}
