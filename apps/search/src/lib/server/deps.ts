// The process's index, embedder and caches. Built on first use, never at module load, so the
// bundler and the tests never connect.
import { createCivitaiClient } from '@civitai/orchestration-client';
import { createCacheRedis, REDIS_KEYS } from '@civitai/redis';
import {
  createQueryEmbedder,
  EMBED_DIMENSIONS,
  EMBED_MODEL,
  type EmbeddingOutput,
  type QueryEmbedder,
  type VectorCache,
} from './embedder';
import { queryVectorCache } from './metrics';
import { createQdrantIndex, type VectorIndex } from './qdrant';

// Readers go through the alias, so a new collection becomes live by moving it.
const IMAGE_ALIAS = process.env.QDRANT_IMAGE_COLLECTION ?? 'images_semantic';

export type SearchDeps = { images: { index: VectorIndex; embed: QueryEmbedder } };

function redisVectorCache(): VectorCache | undefined {
  if (!process.env.REDIS_URL || !process.env.REDIS_SYS_URL) return undefined;
  const redis = createCacheRedis();
  return {
    async get(key) {
      const vector = await redis.packed.get<number[]>(key as never);
      queryVectorCache.inc({ result: vector ? 'hit' : 'miss' });
      return vector;
    },
    async set(key, vector, ttlSeconds) {
      await redis.packed.set(key as never, vector, { EX: ttlSeconds });
    },
  };
}

let deps: SearchDeps | undefined;
export function getSearchDeps(log: (msg: string, details: object) => void): SearchDeps {
  if (deps) return deps;
  const orchestrator = createCivitaiClient({
    baseUrl: process.env.ORCHESTRATOR_ENDPOINT ?? '',
    env: process.env.ORCHESTRATOR_MODE === 'dev' ? 'dev' : 'prod',
    auth: process.env.ORCHESTRATOR_ACCESS_TOKEN ?? '',
  });
  const embed = createQueryEmbedder({
    embedText: async (text) => {
      const { data, error } = await orchestrator.post<{ 200: EmbeddingOutput }>({
        url: '/v2/consumer/recipes/multimodalEmbedding',
        body: { model: EMBED_MODEL, dimensions: EMBED_DIMENSIONS, precision: 'float32', text },
        headers: { 'Content-Type': 'application/json' },
      });
      if (error) throw new Error(JSON.stringify(error));
      return data;
    },
    cache: redisVectorCache(),
    // Shared with the main app's former in-process search, so the cache stays warm across the move.
    cachePrefix: REDIS_KEYS.SEMANTIC_SEARCH.QUERY_VECTOR,
    onMismatch: (got, index) => log('query model does not match the index', { got, index }),
  });
  deps = {
    images: {
      index: createQdrantIndex({
        url: process.env.QDRANT_URL ?? '',
        apiKey: process.env.QDRANT_API_KEY,
        collection: IMAGE_ALIAS,
      }),
      embed,
    },
  };
  return deps;
}
