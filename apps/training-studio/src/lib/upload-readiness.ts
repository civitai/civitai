import { forEachPooled } from './orchestrator-core';

/** Where one dataset file stands for training. `failed` is not final: each read of it retries. */
export type BlobReadiness = 'ready' | 'processing' | 'failed' | 'unusable';

/** POST /api/dataset-readiness with `blobIds`. `states` covers only the blobs read before the deadline. */
export type ReadinessProbe =
  | { enabled: false }
  | { enabled: true; states: Record<string, BlobReadiness> };

/** POST /api/dataset-readiness with `run`: whether the orchestrator would take the dataset now. `ready`
 *  null means the whatif answered something else, which never holds Start. */
export type ReadinessCheck = { enabled: false } | { enabled: true; ready: boolean | null };

/** One raw HEAD of a dataset blob. Not the SDK client: its interceptor drops an error response's headers,
 *  and it turns a timeout into a missing response. */
export type BlobHead = (air: string, signal: AbortSignal) => Promise<Response>;

/** The HEAD waits server-side for as long as the file is still processing; past this it counts as processing. */
export const READINESS_HEAD_TIMEOUT_MS = 15_000;
/** No HEAD starts after this, so one request stays short; the rest are read on the next poll. */
export const READINESS_DEADLINE_MS = 20_000;
const READINESS_CONCURRENCY = 8;

/** One HEAD's answer as a readiness state; null for an answer that says nothing about readiness. */
export function classifyBlobHead(status: number, headers: Headers): BlobReadiness | null {
  if (status >= 200 && status < 300) return headers.has('x-blocked-reason') ? 'unusable' : 'ready';
  if (status === 404) return 'unusable';
  if (status === 503) {
    const state = headers.get('x-scan-status')?.toLowerCase();
    if (state === 'pending') return 'processing';
    if (state === 'failed') return 'failed';
  }
  return null;
}

/** Reads each blob once. A HEAD past its timeout counts as processing; any other error, or an answer that
 *  says nothing about readiness, counts as ready, so the submit decides. */
export async function probeBlobReadiness(
  head: BlobHead,
  airs: string[],
  {
    timeoutMs = READINESS_HEAD_TIMEOUT_MS,
    deadlineMs = READINESS_DEADLINE_MS,
    now = Date.now,
  }: { timeoutMs?: number; deadlineMs?: number; now?: () => number } = {}
): Promise<Record<string, BlobReadiness>> {
  const states: Record<string, BlobReadiness> = {};
  const stopAt = now() + deadlineMs;
  await forEachPooled(
    [...new Set(airs)],
    READINESS_CONCURRENCY,
    async (air) => {
      try {
        const res = await head(air, AbortSignal.timeout(timeoutMs));
        states[air] = classifyBlobHead(res.status, res.headers) ?? 'ready';
      } catch (err) {
        states[air] = (err as Error)?.name === 'TimeoutError' ? 'processing' : 'ready';
      }
    },
    () => now() >= stopAt
  );
  return states;
}
