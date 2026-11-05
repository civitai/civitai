import { createHash } from 'node:crypto';
import { SearchError } from './errors';
import type { ModelStamp } from './qdrant';

export const EMBED_MODEL = 'wemm-2b';
export const EMBED_DIMENSIONS = 256;
const QUERY_VECTOR_TTL_SECONDS = 60 * 60 * 24 * 7;

/** Whitespace only: case can carry meaning (names, styles), so it reaches the model unchanged. */
export function normalizeQuery(text: string) {
  return text.trim().replace(/\s+/g, ' ');
}

export type EmbeddingOutput = ModelStamp & { embedding?: number[] };
/** One orchestrator `multimodalEmbedding` recipe call. */
export type EmbedText = (text: string) => Promise<EmbeddingOutput | undefined>;
export type VectorCache = {
  get(key: string): Promise<number[] | null>;
  set(key: string, vector: number[], ttlSeconds: number): Promise<void>;
};

export type QueryEmbedder = (text: string, stamp: ModelStamp) => Promise<number[]>;

/**
 * Embeds query text with the model that produced the index, caching the vector. A vector from a
 * different model revision or preprocessing profile is meaningless against the index, so it is refused.
 */
export function createQueryEmbedder({
  embedText,
  cache,
  cachePrefix,
  onMismatch,
}: {
  embedText: EmbedText;
  cache?: VectorCache;
  cachePrefix: string;
  onMismatch?: (got: ModelStamp, index: ModelStamp) => void;
}): QueryEmbedder {
  return async (raw, stamp) => {
    if (!stamp.modelRevision) throw new SearchError(412, 'The index has no vectors yet');
    const text = normalizeQuery(raw);
    const hash = createHash('sha256').update(text).digest('hex');
    const key = `${cachePrefix}:${EMBED_MODEL}:${EMBED_DIMENSIONS}:${stamp.modelRevision}:${stamp.profile}:${hash}`;

    const cached = await cache?.get(key).catch(() => null);
    if (cached) return cached;

    const out = await embedText(text).catch((err) => {
      throw new SearchError(502, `Embedding failed: ${String(err)}`);
    });
    if (!out?.embedding) throw new SearchError(502, 'Embedding failed');
    if (out.modelRevision !== stamp.modelRevision || out.profile !== stamp.profile) {
      onMismatch?.(out, stamp);
      throw new SearchError(412, 'The search model does not match the index');
    }

    await cache?.set(key, out.embedding, QUERY_VECTOR_TTL_SECONDS).catch(() => undefined);
    return out.embedding;
  };
}
