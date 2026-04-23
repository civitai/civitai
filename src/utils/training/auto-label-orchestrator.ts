import type { Blob as OrchestratorBlob } from '@civitai/client';
import {
  applyCaptionPostProcess,
  applyTagPostProcess,
  type TagPostProcessOptions,
} from '~/components/Training/Form/TrainingCommon';
import { AUTO_LABEL_BATCH_SIZE } from '~/server/schema/training.schema';
import { trpcVanilla } from '~/utils/trpc';

// Polling cadence — the orchestrator updates step status as work completes,
// so 5s gives reasonably fresh feedback without hammering the read endpoint.
const POLL_INTERVAL_MS = 5000;
// Hard ceiling so a stuck workflow can't poll forever.
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

const TERMINAL_WORKFLOW_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);
const TERMINAL_STEP_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);

export type AutoLabelImageInput = {
  /** Filename used to match the result back to the source image in the store. */
  filename: string;
  blob: Blob;
};

type CommonOptions = {
  modelId: number;
  mediaType: 'image' | 'video';
  images: AutoLabelImageInput[];
  // Post-processing is purely client-side now — the server never sees these fields.
  postProcess: TagPostProcessOptions;
  signal?: AbortSignal;
  /** Called before every poll tick and every result emit. Returning false stops the
   *  background work cleanly — used to cancel a poll loop when the user resets the
   *  store-level autoLabeling state (e.g. opens a fresh run, navigates away). */
  isActive?: () => boolean;
  onUploadProgress?: (uploaded: number, total: number) => void;
  onResult?: (filename: string, label: string) => void;
  onFailure?: (filename: string, reason: string) => void;
  onDone?: (summary: { successes: number; fails: string[] }) => void;
};

export type SubmitAutoLabelOptions =
  | (CommonOptions & {
      type: 'tag';
      params: { threshold: number };
    })
  | (CommonOptions & {
      type: 'caption';
      params: { temperature: number; maxNewTokens: number };
    });

export type AutoLabelHandle = {
  workflowIds: string[];
  cancel: () => void;
};

type SubmittedBatch = {
  workflowId: string;
  // Map step.name (the unique batch index "0".."15") → filename. We dedup on step.name
  // because two source images can collide on filename (e.g. duplicate uploads), and
  // step.name is what we actually set when building the workflow.
  stepNameToFilename: Map<string, string>;
  reported: Set<string>;
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

async function uploadBlobToPresignedUrl(
  uploadUrl: string,
  blob: Blob,
  signal?: AbortSignal
): Promise<OrchestratorBlob> {
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream' },
    body: blob,
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`Blob upload failed (${response.status}): ${text}`);
  }
  return (await response.json()) as OrchestratorBlob;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Upload N images to the orchestrator, submit one workflow per batch (up to
 * {@link AUTO_LABEL_BATCH_SIZE}), and poll each workflow until every step is
 * terminal. Per-image results are emitted via callbacks rather than batched at
 * the end so the UI can paint labels as they arrive.
 *
 * Cancellation: pass an `AbortSignal`, call the returned `cancel()`, or supply
 * `isActive` and have it return false. In-flight uploads abort immediately;
 * polling stops at the next tick. Already-submitted workflows keep running on
 * the orchestrator side (we don't try to cancel them — they're cheap and will
 * finish on their own).
 */
export async function uploadAndSubmitAutoLabel(
  opts: SubmitAutoLabelOptions
): Promise<AutoLabelHandle> {
  if (opts.images.length === 0) throw new Error('No images to label');

  const internal = new AbortController();
  const externalSignal = opts.signal;
  if (externalSignal) {
    if (externalSignal.aborted) internal.abort();
    else externalSignal.addEventListener('abort', () => internal.abort(), { once: true });
  }
  const signal = internal.signal;

  const isStillActive = () => !signal.aborted && (opts.isActive?.() ?? true);

  const batches = chunk(opts.images, AUTO_LABEL_BATCH_SIZE);
  const totalImages = opts.images.length;

  let uploaded = 0;
  let successes = 0;
  const fails: string[] = [];
  const submittedBatches: SubmittedBatch[] = [];

  // ---- Phase A: upload + submit each batch sequentially. Submitting per-batch
  // (instead of one giant workflow) keeps each workflow at ≤AUTO_LABEL_BATCH_SIZE
  // steps so the orchestrator can schedule them concurrently, and isolates
  // failures to a single batch instead of an entire run.
  for (const batch of batches) {
    if (!isStillActive()) throw new DOMException('Aborted', 'AbortError');

    const resolved: { mediaUrl: string; filename: string }[] = [];
    for (const img of batch) {
      if (!isStillActive()) throw new DOMException('Aborted', 'AbortError');
      const { uploadUrl } = await trpcVanilla.training.getAutoLabelUploadUrl.mutate();
      const result = await uploadBlobToPresignedUrl(uploadUrl, img.blob, signal);
      if (!result.url) {
        // Treat missing URL as a per-image failure rather than aborting the batch.
        fails.push(img.filename);
        opts.onFailure?.(img.filename, 'Upload returned no URL');
        continue;
      }
      resolved.push({ mediaUrl: result.url, filename: img.filename });
      uploaded += 1;
      opts.onUploadProgress?.(uploaded, totalImages);
    }

    if (resolved.length === 0) continue;

    const submission = await trpcVanilla.training.submitAutoLabelWorkflow.mutate({
      modelId: opts.modelId,
      mediaType: opts.mediaType,
      images: resolved,
      params:
        opts.type === 'tag'
          ? { type: 'tag', threshold: opts.params.threshold }
          : {
              type: 'caption',
              temperature: opts.params.temperature,
              maxNewTokens: opts.params.maxNewTokens,
            },
    });

    // Server names each step by its zero-based index in the resolved list. We
    // mirror that here so the poll loop can map step.name → filename.
    const stepNameToFilename = new Map<string, string>();
    resolved.forEach((r, idx) => stepNameToFilename.set(`${idx}`, r.filename));

    submittedBatches.push({
      workflowId: submission.workflowId,
      stepNameToFilename,
      reported: new Set(),
    });
  }

  // ---- Phase B: poll every workflow until all steps are terminal, applying
  // post-processing as results land. Polling runs as a side effect; the caller
  // observes progress through the callbacks. The promise we return resolves as
  // soon as the submit phase is done so the UI can drop the spinner.
  const startedAt = Date.now();

  const markBatchUnreportedAsFailed = (batch: SubmittedBatch, reason: string) => {
    for (const [stepName, filename] of batch.stepNameToFilename) {
      if (batch.reported.has(stepName)) continue;
      batch.reported.add(stepName);
      fails.push(filename);
      opts.onFailure?.(filename, reason);
    }
  };

  const batchesByWorkflowId = new Map(submittedBatches.map((b) => [b.workflowId, b] as const));

  const poll = async () => {
    const pending = new Set(submittedBatches.map((b) => b.workflowId));

    while (pending.size > 0) {
      if (!isStillActive()) return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        for (const workflowId of pending) {
          const batch = batchesByWorkflowId.get(workflowId);
          if (batch) markBatchUnreportedAsFailed(batch, 'Polling timed out');
        }
        break;
      }

      // Snapshot pending IDs for this tick so deletes during the forEach below
      // don't shift the index lookup we'd otherwise need to do later.
      const tickIds = Array.from(pending);
      const results = await Promise.allSettled(
        tickIds.map((workflowId) =>
          trpcVanilla.training.getAutoLabelWorkflow.query({ workflowId })
        )
      );

      results.forEach((result, idx) => {
        const polledId = tickIds[idx];
        if (result.status === 'rejected') return; // transient — try again next tick
        const wf = result.value;
        const batch = batchesByWorkflowId.get(polledId);
        if (!batch) return;

        for (const step of wf.steps) {
          if (!step.name) continue;
          if (batch.reported.has(step.name)) continue;
          if (!TERMINAL_STEP_STATUSES.has(step.status)) continue;

          const filename = batch.stepNameToFilename.get(step.name);
          if (!filename) continue;

          batch.reported.add(step.name);

          if (step.status !== 'succeeded') {
            fails.push(filename);
            opts.onFailure?.(filename, `Step ${step.status}`);
            continue;
          }

          let label: string | null = null;
          if (wf.type === 'tag') {
            const rawTags = (step.output as { tags?: { [tag: string]: number } } | null)?.tags;
            const tags = applyTagPostProcess(rawTags, opts.postProcess);
            label = tags.length > 0 ? tags.join(', ') : null;
          } else {
            const rawCaption = (step.output as { caption?: string } | null)?.caption;
            label = applyCaptionPostProcess(rawCaption);
          }

          if (label && isStillActive()) {
            successes += 1;
            opts.onResult?.(filename, label);
          } else if (!label) {
            fails.push(filename);
            opts.onFailure?.(filename, 'Empty result');
          }
        }

        if (TERMINAL_WORKFLOW_STATUSES.has(wf.status ?? '')) {
          pending.delete(polledId);
        }
      });

      if (pending.size > 0) await sleep(POLL_INTERVAL_MS, signal);
    }

    if (isStillActive()) opts.onDone?.({ successes, fails });
  };

  poll().catch((err) => {
    if ((err as DOMException)?.name === 'AbortError') return;
    // Surface unexpected errors as a global failure marker.
    opts.onFailure?.('', err instanceof Error ? err.message : String(err));
    opts.onDone?.({ successes, fails });
  });

  return {
    workflowIds: submittedBatches.map((b) => b.workflowId),
    cancel: () => internal.abort(),
  };
}
