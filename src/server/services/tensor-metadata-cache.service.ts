import { createHash } from 'node:crypto';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';
import type { ModelTensorAnalysis } from '~/utils/model-tensor-metadata';
import { bustFullTensorAnalysis, getFullTensorAnalysisCached } from './tensor-metadata.service';

export type ModelTensorSummary = Omit<ModelTensorAnalysis, 'tensors'>;
export type ModelTensorCacheSource = {
  fileId: number;
  /** Stable URL stored on ModelFile, never a rotating signed delivery URL. */
  fileUrl: string;
};

function contentFingerprint(fileUrl: string) {
  return createHash('sha256').update(fileUrl).digest('hex');
}

export function getModelTensorCacheIdentity({ fileId, fileUrl }: ModelTensorCacheSource) {
  return `${fileId}:${contentFingerprint(fileUrl)}`;
}

const fullCacheKey = (source: ModelTensorCacheSource) =>
  `${REDIS_KEYS.CACHES.TENSOR_METADATA}:${getModelTensorCacheIdentity(source)}` as const;
const summaryCacheKey = (source: ModelTensorCacheSource) =>
  `${REDIS_KEYS.CACHES.TENSOR_METADATA_SUMMARY}:${getModelTensorCacheIdentity(source)}` as const;
const legacyFullCacheKey = (fileId: number) =>
  `${REDIS_KEYS.CACHES.TENSOR_METADATA}:${fileId}` as const;
const legacySummaryCacheKey = (fileId: number) =>
  `${REDIS_KEYS.CACHES.TENSOR_METADATA_SUMMARY}:${fileId}` as const;

/**
 * Return the full tensor analysis, sharing both the compressed Redis cache and
 * the decoded-object LRU used by the tensor-metadata API.
 */
export function getModelTensorAnalysisCached(
  source: ModelTensorCacheSource,
  loadAnalysis: () => Promise<ModelTensorAnalysis>
) {
  const cacheIdentity = getModelTensorCacheIdentity(source);
  return getFullTensorAnalysisCached(cacheIdentity, () =>
    fetchThroughCache(fullCacheKey(source), loadAnalysis, {
      ttl: CacheTTL.month,
      compress: true,
    })
  );
}

/**
 * Return the small tensor summary without touching the full analysis on a
 * summary-cache hit. `loadAnalysis` must stay lazy: callers may resolve signed
 * download URLs or fetch model headers inside it without adding that work to
 * the hot summary path.
 */
export function getModelTensorSummaryCached(
  source: ModelTensorCacheSource,
  loadAnalysis: () => Promise<ModelTensorAnalysis>
) {
  return fetchThroughCache(
    summaryCacheKey(source),
    async (): Promise<ModelTensorSummary> => {
      const analysis = await getModelTensorAnalysisCached(source, loadAnalysis);
      const { tensors: _tensors, ...summary } = analysis;
      return summary;
    },
    { ttl: CacheTTL.month }
  );
}

/**
 * Bound a request that needs the summary immediately while leaving the shared
 * cache fill running after a timeout. The caller can fail open for this response;
 * a later retry will consume the warmed summary if the original load completes.
 */
export function getModelTensorSummaryCachedWithTimeout(
  source: ModelTensorCacheSource,
  loadAnalysis: () => Promise<ModelTensorAnalysis>,
  timeoutMs: number,
  onTimeout?: () => void
) {
  return withTimeoutFallback(
    getModelTensorSummaryCached(source, loadAnalysis),
    timeoutMs,
    null,
    onTimeout
  );
}

/**
 * A ModelFile URL can be replaced while retaining its database id. Evict the
 * settled entries for the old content plus the pre-fingerprint legacy entries.
 * An old parse already in flight may repopulate only its old fingerprint; reads
 * for the replacement URL use a different identity and can never observe it.
 */
export async function bustModelTensorMetadataCaches(fileId: number, oldFileUrl?: string) {
  // Keep the numeric eviction during rollout in case this process still holds
  // an entry created by code using the legacy file-id-only identity.
  bustFullTensorAnalysis(fileId);

  const deletes = [redis.del(legacyFullCacheKey(fileId)), redis.del(legacySummaryCacheKey(fileId))];
  if (oldFileUrl) {
    const source = { fileId, fileUrl: oldFileUrl };
    bustFullTensorAnalysis(getModelTensorCacheIdentity(source));
    deletes.push(redis.del(fullCacheKey(source)), redis.del(summaryCacheKey(source)));
  }

  await Promise.all(deletes);
}
