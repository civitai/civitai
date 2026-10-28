// Client side of auto-labeling: submit uploaded blobs in batches through the backend seam, poll each
// workflow, and stream results back per tile via `onResult`. Mirrors the main app's poll loop (5s in
// prod; a touch faster here). Results are keyed by the `key` the caller sends, which must be unique per run.

import { backend } from '$lib/host';
import type { Media } from '$lib/data/trainingModels';
import type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/backend';

export type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/backend';

const BATCH_SIZE = 16;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

// Every submitted item is a charged orchestrator job. However a caller asks — the drain, a format
// switch, the editor's Re-run — one media URL is sent at most this many times per page session, so a
// caller that keeps re-selecting the same tiles stops after a bounded spend instead of draining the
// user's Buzz (the earlier auto-label loop recurred after its fix with the same signature).
export const MAX_SUBMITS_PER_MEDIA = 3;
const submitsByMedia = new Map<string, number>();

// Counted per blob, not per URL string: a re-signed URL for the same blob must not reset its count.
function mediaKey(mediaUrl: string): string {
  try {
    const url = new URL(mediaUrl);
    return url.origin + url.pathname;
  } catch {
    return mediaUrl;
  }
}

/** Split `items` into those still under `cap` in `ledger` (counted as submitted now, before the
 *  request, since a failed submit may still have been charged) and those refused. */
export function claimSubmits(ledger: Map<string, number>, items: AutoLabelItem[], cap: number) {
  const allowed: AutoLabelItem[] = [];
  const refused: AutoLabelItem[] = [];
  for (const item of items) {
    const key = mediaKey(item.mediaUrl);
    const count = ledger.get(key) ?? 0;
    if (count >= cap) {
      refused.push(item);
      continue;
    }
    ledger.set(key, count + 1);
    allowed.push(item);
  }
  return { allowed, refused };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true }
    );
  });
}

async function submitBatch(
  mode: AutoLabelMode,
  media: Media,
  items: AutoLabelItem[]
): Promise<string> {
  const { workflowId } = await backend().autoLabelSubmit(items, mode, media);
  return workflowId;
}

function pollOnce(
  workflowId: string,
  signal: AbortSignal
): Promise<{ done: boolean; results: AutoLabelResult[] }> {
  return backend().autoLabelPoll(workflowId, signal);
}

const isAbort = (err: unknown) => (err as DOMException | undefined)?.name === 'AbortError';

async function runBatch(
  mode: AutoLabelMode,
  media: Media,
  batch: AutoLabelItem[],
  onResult: (r: AutoLabelResult) => void,
  signal: AbortSignal
): Promise<void> {
  const applied = new Set<string>();
  let submitError: string | undefined;
  try {
    const workflowId = await submitBatch(mode, media, batch).catch((err) => {
      if (!isAbort(err) && err instanceof Error) submitError = err.message;
      throw err;
    });
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const { done, results } = await pollOnce(workflowId, signal);
        for (const r of results) {
          if (r.status !== 'pending' && !applied.has(r.key)) {
            applied.add(r.key);
            onResult(r);
          }
        }
        if (done) break;
      } catch (err) {
        if (isAbort(err)) throw err; // exit finishes the flow; other errors are transient — keep polling
      }
      await sleep(POLL_INTERVAL_MS, signal);
    }
  } catch (err) {
    if (isAbort(err)) throw err; // let runAutoLabel see the abort; submit failures fall through to fail
  } finally {
    // Anything unresolved (submit failed, timed out, or a workflow that ended without emitting the step)
    // fails so the tile stops showing "labeling…". Skipped on abort — the caller resets those.
    if (!signal.aborted) {
      for (const item of batch) {
        if (!applied.has(item.key))
          onResult({ key: item.key, status: 'failed', ...(submitError && { error: submitError }) });
      }
    }
  }
}

/** Auto-label every item, batched. `onResult` fires at most once per key as each image resolves;
 *  items over the per-media cap fail without being sent. Resolves with how many items were sent once
 *  all batches are terminal; rejects only on abort. */
export async function runAutoLabel(
  mode: AutoLabelMode,
  media: Media,
  items: AutoLabelItem[],
  onResult: (r: AutoLabelResult) => void,
  signal: AbortSignal
): Promise<number> {
  const { allowed, refused } = claimSubmits(submitsByMedia, items, MAX_SUBMITS_PER_MEDIA);
  if (refused.length) {
    console.warn(
      `[training-studio] auto-label refused ${refused.length} item(s) over the per-image cap`
    );
    for (const item of refused) onResult({ key: item.key, status: 'failed' });
  }
  await Promise.all(
    chunk(allowed, BATCH_SIZE).map((batch) => runBatch(mode, media, batch, onResult, signal))
  );
  return allowed.length;
}
