// Client side of auto-labeling: submit uploaded blobs in batches through the backend seam, poll each
// workflow, and stream results back per tile via `onResult`. Mirrors the main app's poll loop (5s in
// prod; a touch faster here). Labels are keyed by the tile id we send as `key`.

import { backend } from '$lib/host';
import type { Media } from '$lib/data/trainingModels';
import type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/backend';

export type { AutoLabelItem, AutoLabelMode, AutoLabelResult } from '$lib/backend';

const BATCH_SIZE = 16;
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

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
  try {
    const workflowId = await submitBatch(mode, media, batch);
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
        if (!applied.has(item.key)) onResult({ key: item.key, status: 'failed' });
      }
    }
  }
}

/** Auto-label every item, batched. `onResult` fires at most once per key as each image resolves.
 *  Resolves when all batches are terminal; rejects only on abort. */
export async function runAutoLabel(
  mode: AutoLabelMode,
  media: Media,
  items: AutoLabelItem[],
  onResult: (r: AutoLabelResult) => void,
  signal: AbortSignal
): Promise<void> {
  await Promise.all(
    chunk(items, BATCH_SIZE).map((batch) => runBatch(mode, media, batch, onResult, signal))
  );
}
