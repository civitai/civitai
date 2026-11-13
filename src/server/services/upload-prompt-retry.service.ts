import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

/**
 * Scans an upload prompt gets after the first one ends with no verdict. A retry with no verdict
 * queues the next one until this cap; past it, a scan with no verdict queues nothing further. So one
 * scan request (one delivery of the image scan webhook) leads to at most
 * `1 + UPLOAD_PROMPT_MAX_RETRIES` scans. A redelivered webhook starts its own count.
 */
export const UPLOAD_PROMPT_MAX_RETRIES = 3;
/** The wait before retry n (index n - 1). Together they outlast an orchestrator outage of hours. */
export const UPLOAD_PROMPT_RETRY_DELAYS_MS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000] as const;

const QUEUE = REDIS_SYS_KEYS.SYSTEM.UPLOAD_PROMPT_SCAN_RETRY;
const ATTEMPTS = `${QUEUE}:attempts` as const;

export type UploadPromptRetryStore = Pick<
  typeof sysRedis,
  'zAdd' | 'zRange' | 'zRem' | 'hSet' | 'hGet' | 'hDel'
>;
export type DueUploadPromptRetry = { imageId: number; attempt: number };

/**
 * Queues another scan of an upload prompt that had no verdict. `attempt` is the retry this entry
 * will be (1 for the first). Past the cap it queues nothing. Never throws: losing a retry leaves
 * the image as it was without one.
 */
export async function queueUploadPromptRetry({
  imageId,
  attempt,
  now = Date.now(),
  store = sysRedis,
}: {
  imageId: number;
  attempt: number;
  now?: number;
  store?: UploadPromptRetryStore;
}) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > UPLOAD_PROMPT_MAX_RETRIES) {
    logToAxiom({
      name: 'upload-prompt-scan',
      type: 'warning',
      message: 'retries exhausted',
      imageId,
      attempt,
    }).catch(() => null);
    return false;
  }
  try {
    const member = String(imageId);
    // The attempt goes first, so a run never takes an entry whose attempt is not written yet.
    await store.hSet(ATTEMPTS, member, String(attempt));
    await store.zAdd(QUEUE, {
      score:
        now +
        UPLOAD_PROMPT_RETRY_DELAYS_MS[Math.min(attempt, UPLOAD_PROMPT_RETRY_DELAYS_MS.length) - 1],
      value: member,
    });
    return true;
  } catch (error) {
    logToAxiom({
      name: 'upload-prompt-scan',
      type: 'error',
      message: `retry not queued: ${error instanceof Error ? error.message : 'Unknown error'}`,
      imageId,
      attempt,
    }).catch(() => null);
    return false;
  }
}

/**
 * Takes up to `limit` retries that are due, removing each from the queue. An entry another run
 * removed first is skipped, so two runs never scan the same entry. An entry whose attempt is
 * missing counts as the last retry, so it cannot be re-queued forever.
 */
export async function takeDueUploadPromptRetries({
  limit,
  now = Date.now(),
  store = sysRedis,
}: {
  limit: number;
  now?: number;
  store?: UploadPromptRetryStore;
}): Promise<DueUploadPromptRetry[]> {
  const members = await store.zRange(QUEUE, 0, now, {
    BY: 'SCORE',
    LIMIT: { offset: 0, count: limit },
  });
  const due: DueUploadPromptRetry[] = [];
  for (const raw of members) {
    // The Sentinel sysRedis client can hand members back as Buffers.
    const member = String(raw);
    if (!(await store.zRem(QUEUE, member))) continue;
    // The entry is ours now. If its attempt cannot be read it still runs, as the last retry.
    const stored = await store
      .hGet(ATTEMPTS, member)
      .then(async (value) => (await store.hDel(ATTEMPTS, member), value))
      .catch(() => null);
    const imageId = Number(member);
    if (!Number.isInteger(imageId) || imageId <= 0) continue;
    const attempt = Number(stored == null ? NaN : String(stored));
    due.push({
      imageId,
      attempt:
        Number.isInteger(attempt) && attempt >= 1 && attempt <= UPLOAD_PROMPT_MAX_RETRIES
          ? attempt
          : UPLOAD_PROMPT_MAX_RETRIES,
    });
  }
  return due;
}
