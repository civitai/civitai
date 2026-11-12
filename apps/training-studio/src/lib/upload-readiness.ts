import { headBlob } from '@civitai/orchestration-client';
import { blobIdFromAir, type OrchestratorClient } from './orchestrator-core';

/** Where one dataset file stands for training. `failed` is not final: each read of it retries. */
export type BlobReadiness = 'ready' | 'processing' | 'failed' | 'unusable';

/** POST /api/dataset-readiness with `blobIds`. `states` covers only the blobs read before the deadline. */
export type ReadinessProbe =
  | { enabled: false }
  | { enabled: true; states: Record<string, BlobReadiness> };

/** POST /api/dataset-readiness with `run`: whether the orchestrator would take the dataset now. `ready`
 *  null means the whatif answered something else, which never holds Start. */
export type ReadinessCheck = { enabled: false } | { enabled: true; ready: boolean | null };

/** The HEAD waits server-side for as long as the file is still processing; past this it counts as processing. */
export const READINESS_HEAD_TIMEOUT_MS = 15_000;
/** No HEAD starts after this, so one request stays short; the rest are read on the next poll. */
export const READINESS_DEADLINE_MS = 20_000;
const READINESS_CONCURRENCY = 8;

/** One HEAD's answer as a readiness state; null for an answer that says nothing about readiness. */
export function classifyBlobHead(
  status: number | undefined,
  headers: Headers | undefined
): BlobReadiness | null {
  if (status === undefined) return null;
  if (status >= 200 && status < 300) return headers?.has('x-blocked-reason') ? 'unusable' : 'ready';
  if (status === 404) return 'unusable';
  if (status === 503) {
    // Only a still-processing answer carries Retry-After; a failed one leaves the retry to the next read.
    if (headers?.get('x-scan-status')?.toLowerCase() === 'failed' || !headers?.has('retry-after'))
      return 'failed';
    return 'processing';
  }
  return null;
}

/** Reads each blob once. A HEAD past its timeout, or one that throws, counts as processing; an answer
 *  that says nothing about readiness counts as ready, so the submit decides. Never send a workflowId. */
export async function probeBlobReadiness(
  client: OrchestratorClient,
  airs: string[],
  {
    timeoutMs = READINESS_HEAD_TIMEOUT_MS,
    deadlineMs = READINESS_DEADLINE_MS,
    now = Date.now,
  }: { timeoutMs?: number; deadlineMs?: number; now?: () => number } = {}
): Promise<Record<string, BlobReadiness>> {
  const unique = [...new Set(airs)];
  const states: Record<string, BlobReadiness> = {};
  const stopAt = now() + deadlineMs;
  let next = 0;
  const worker = async () => {
    while (next < unique.length && now() < stopAt) {
      const air = unique[next++]!;
      try {
        const { response } = await headBlob({
          client,
          path: { blobId: blobIdFromAir(air) },
          signal: AbortSignal.timeout(timeoutMs),
        });
        states[air] = classifyBlobHead(response?.status, response?.headers) ?? 'ready';
      } catch {
        states[air] = 'processing';
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READINESS_CONCURRENCY, unique.length) }, worker));
  return states;
}
