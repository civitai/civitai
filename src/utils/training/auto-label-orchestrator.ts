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
// Browsers cap at ~6 concurrent requests/origin; staying at 4 leaves headroom
// for tRPC + image source fetches happening in parallel.
const UPLOAD_CONCURRENCY = 4;
// One bounded retry on transient network/5xx for presign + submit. Polling
// already tolerates per-tick failures via Promise.allSettled.
const RETRY_DELAY_MS = 1500;

const TERMINAL_WORKFLOW_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);
const TERMINAL_STEP_STATUSES = new Set(['succeeded', 'failed', 'expired', 'canceled']);

export type AutoLabelImageInput = {
  /** Stable per-image identifier — must be unique across the input list. The
   *  caller picks this; passing the source URL is a good default since URLs
   *  don't collide the way short filenames do. */
  key: string;
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
  onUploadStart?: () => void;
  onUploadProgress?: (uploaded: number, total: number) => void;
  onUploadComplete?: () => void;
  onResult?: (key: string, label: string) => void;
  onFailure?: (key: string, reason: string) => void;
  onFatal?: (reason: string) => void;
  onDone?: (summary: { successes: number; failedKeys: string[] }) => void;
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
  // step.name (the unique batch index "0".."15") → caller's image key.
  stepNameToKey: Map<string, string>;
  reported: Set<string>;
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

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

/** Run `task` over `items` with at most `concurrency` in flight. Preserves
 *  callsite ordering of returned results regardless of completion order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await task(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/** RFC 7807 problem-details parser. The orchestrator returns
 *  { type, title, status, detail, traceId } for things like content-policy hits;
 *  surface `title` + `detail` rather than dumping JSON at the user. */
function parseOrchestratorProblem(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as {
      title?: string;
      detail?: string;
      message?: string;
    };
    const parts = [body.title, body.detail].filter(
      (p): p is string => typeof p === 'string' && p.length > 0
    );
    if (parts.length > 0) return parts.join(' — ');
    if (typeof body.message === 'string' && body.message.length > 0) return body.message;
  } catch {
    // not JSON, fall through
  }
  // Truncate raw bodies (XML envelopes, HTML, etc.) so the toast stays usable.
  const trimmed = text.trim();
  if (trimmed.length === 0) return `HTTP ${status}`;
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

class UploadError extends Error {
  constructor(public readonly status: number, public readonly reason: string) {
    super(reason);
    this.name = 'UploadError';
  }
  /** True for cases that re-uploading won't help with — content policy etc. */
  get isPermanent() {
    return this.status === 422 || this.status === 415 || this.status === 413;
  }
}

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
    throw new UploadError(response.status, parseOrchestratorProblem(text, response.status));
  }
  return (await response.json()) as OrchestratorBlob;
}

const isAbort = (err: unknown) => (err as DOMException | undefined)?.name === 'AbortError';

/** Translate tRPC / orchestrator errors into a single short, user-readable line.
 *  tRPC stuffs the serialized zod issue array into `err.message`, so without
 *  this users see things like
 *    `[ { "code": "custom", "path": [...], "message": "..." }, ... ]`
 *  in their toast. We prefer the structured `data.zodError` if present, then
 *  fall back to the message — but if the message looks like JSON, we try to
 *  pull a sensible summary out instead of dumping it. */
function describeError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (!(err instanceof Error)) return 'Unknown error';

  const data = (err as { data?: { code?: string; zodError?: unknown } }).data;
  const zodError = data?.zodError as
    | {
        formErrors?: string[];
        fieldErrors?: Record<string, string[] | undefined>;
      }
    | undefined;
  if (zodError) {
    const fieldMessages = Object.values(zodError.fieldErrors ?? {})
      .flat()
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
    const firstMessage = fieldMessages[0] ?? zodError.formErrors?.[0];
    if (firstMessage) return firstMessage;
  }

  const msg = err.message ?? '';
  // tRPC sometimes puts the raw zod issue array straight into `message`.
  // Try to pull the first issue's `message` field instead of dumping JSON.
  if (msg.startsWith('[')) {
    try {
      const issues = JSON.parse(msg) as Array<{ message?: string }>;
      const firstMessage = issues.find(
        (i) => typeof i.message === 'string' && i.message.length > 0
      )?.message;
      if (firstMessage) return firstMessage;
    } catch {
      // not JSON — fall through
    }
    return 'Server rejected the request';
  }
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/** Race a promise against a signal so we don't await forever if `fn()` is hung
 *  (server stall, dropped connection, etc.). The underlying call keeps running
 *  in the background but we stop blocking the worker pool. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      }
    );
  });
}

/** Wrap a tRPC call with one bounded retry on transient errors. tRPC surfaces
 *  network/5xx through TRPCClientError; we treat anything that isn't a 4xx as
 *  retryable since the orchestrator endpoints are idempotent at this layer
 *  (presign mints a fresh URL, submit creates a fresh workflow id). */
async function withRetry<T>(label: string, fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  try {
    return await raceAbort(fn(), signal);
  } catch (err) {
    if (isAbort(err)) throw err;
    const status = (err as { data?: { httpStatus?: number } })?.data?.httpStatus;
    if (status && status >= 400 && status < 500) throw err; // 4xx — caller error, no retry
    await sleep(RETRY_DELAY_MS, signal);
    // Re-throw the original error on retry-fail so the caller's describeError
    // can still introspect `data.zodError`. The label is just a tag we attach.
    return raceAbort(fn(), signal).catch((retryErr) => {
      if (isAbort(retryErr)) throw retryErr;
      if (retryErr instanceof Error) {
        retryErr.message = `${label}: ${retryErr.message}`;
      }
      throw retryErr;
    });
  }
}

/** Best-effort extraction of a friendly per-step failure reason from the
 *  workflow payload. The shape varies by orchestrator version, so probe a few
 *  spots; fall back to the status word. */
function describeStepFailure(step: { status: string; error?: unknown; output?: unknown }): string {
  const error = step.error as { message?: string; detail?: string; title?: string } | undefined;
  if (error) {
    const parts = [error.title, error.detail ?? error.message].filter(
      (p): p is string => typeof p === 'string' && p.length > 0
    );
    if (parts.length > 0) return parts.join(' — ');
  }
  const output = step.output as { error?: string; message?: string } | null | undefined;
  if (output?.error) return output.error;
  if (output?.message) return output.message;
  return step.status === 'failed' ? 'Step failed' : `Step ${step.status}`;
}

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

  const totalImages = opts.images.length;
  let uploaded = 0;
  let successes = 0;
  // Set so a key never gets counted twice if e.g. submit fails AND a later
  // poll-timeout sweep tries to mark the same key.
  const failedKeys = new Set<string>();
  const recordFailure = (key: string, reason: string) => {
    if (!key || failedKeys.has(key)) return;
    failedKeys.add(key);
    opts.onFailure?.(key, reason);
  };
  const submittedBatches: SubmittedBatch[] = [];

  // ---- Phase A: upload everything concurrently. We presign + upload per image
  // (idempotent on the orchestrator side) and only chunk into workflows after
  // all uploads finish, so a slow upload doesn't block the UI from showing
  // overall progress.
  opts.onUploadStart?.();

  type UploadResult =
    | { ok: true; index: number; mediaUrl: string; key: string }
    | { ok: false; index: number; key: string }
    | { ok: false; aborted: true; index: number; key: string };

  const uploadOne = async (img: AutoLabelImageInput, index: number): Promise<UploadResult> => {
    if (!isStillActive()) return { ok: false, aborted: true, index, key: img.key };
    try {
      const { uploadUrl } = await withRetry(
        'Presign request',
        () => trpcVanilla.training.getAutoLabelUploadUrl.mutate({ modelId: opts.modelId }),
        signal
      );
      const result = await uploadBlobToPresignedUrl(uploadUrl, img.blob, signal);
      if (!result.url) {
        recordFailure(img.key, 'Upload returned no URL');
        return { ok: false, index, key: img.key };
      }
      uploaded += 1;
      opts.onUploadProgress?.(uploaded, totalImages);
      return { ok: true, index, mediaUrl: result.url, key: img.key };
    } catch (err) {
      // Abort is expected on cancel — report as aborted, don't toast.
      if (isAbort(err)) return { ok: false, aborted: true, index, key: img.key };
      const reason = describeError(err);
      recordFailure(img.key, reason);
      return { ok: false, index, key: img.key };
    }
  };

  const uploadResults = await mapWithConcurrency(opts.images, UPLOAD_CONCURRENCY, uploadOne);

  // If we were aborted mid-upload, bail without firing onDone — the caller is
  // tearing this run down (cancel button, fresh run, etc.) and shouldn't see
  // a "labeled 0 images" toast.
  if (signal.aborted) {
    return {
      workflowIds: [],
      cancel: () => internal.abort(),
    };
  }

  const succeededUploads = uploadResults.filter(
    (r): r is Extract<UploadResult, { ok: true }> => r.ok
  );

  opts.onUploadComplete?.();

  // ---- Phase B: submit batches. Per-batch (instead of one giant workflow)
  // keeps each workflow at ≤AUTO_LABEL_BATCH_SIZE steps so the orchestrator
  // can schedule them concurrently, and isolates failures to a single batch.
  const batches = chunk(succeededUploads, AUTO_LABEL_BATCH_SIZE);

  for (const batch of batches) {
    if (!isStillActive()) {
      return { workflowIds: [], cancel: () => internal.abort() };
    }
    if (batch.length === 0) continue;

    const resolved = batch.map((b) => ({ mediaUrl: b.mediaUrl, filename: b.key, key: b.key }));

    let submission: { workflowId: string };
    try {
      submission = await withRetry(
        'Workflow submit',
        () =>
          trpcVanilla.training.submitAutoLabelWorkflow.mutate({
            modelId: opts.modelId,
            mediaType: opts.mediaType,
            // Server takes filename for orchestrator metadata; we use the key
            // value because it's already stable+unique. Display filenames are
            // resolved client-side from the key.
            images: resolved.map((r) => ({ mediaUrl: r.mediaUrl, filename: r.filename })),
            params:
              opts.type === 'tag'
                ? { type: 'tag', threshold: opts.params.threshold }
                : {
                    type: 'caption',
                    temperature: opts.params.temperature,
                    maxNewTokens: opts.params.maxNewTokens,
                  },
          }),
        signal
      );
    } catch (err) {
      if (isAbort(err)) {
        return { workflowIds: [], cancel: () => internal.abort() };
      }
      const reason = describeError(err);
      for (const r of resolved) recordFailure(r.key, reason);
      continue;
    }

    // Server names each step by its zero-based index in the resolved list. We
    // mirror that here so the poll loop can map step.name → key. NOTE: this is
    // a contract with the server — see submitAutoLabelWorkflow in
    // training.service.ts. If the server stops naming steps by index, this
    // breaks silently.
    const stepNameToKey = new Map<string, string>();
    resolved.forEach((r, idx) => stepNameToKey.set(`${idx}`, r.key));

    submittedBatches.push({
      workflowId: submission.workflowId,
      stepNameToKey,
      reported: new Set(),
    });
  }

  // ---- Phase C: poll every workflow until all steps are terminal, applying
  // post-processing as results land. Polling runs as a side effect; the caller
  // observes progress through the callbacks. The promise we return resolves as
  // soon as the submit phase is done so the UI can drop the spinner.
  const startedAt = Date.now();

  const markBatchUnreportedAsFailed = (batch: SubmittedBatch, reason: string) => {
    for (const [stepName, key] of batch.stepNameToKey) {
      if (batch.reported.has(stepName)) continue;
      batch.reported.add(stepName);
      recordFailure(key, reason);
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
        tickIds.map((workflowId) => trpcVanilla.training.getAutoLabelWorkflow.query({ workflowId }))
      );

      // The await above released the event loop; cancellation may have fired
      // while we were waiting for tRPC. Bail before processing/emitting.
      if (!isStillActive()) return;

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

          const key = batch.stepNameToKey.get(step.name);
          if (!key) continue;

          batch.reported.add(step.name);

          if (step.status !== 'succeeded') {
            recordFailure(key, describeStepFailure(step));
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

          if (label) {
            successes += 1;
            opts.onResult?.(key, label);
          } else {
            recordFailure(key, 'Empty result');
          }
        }

        // Done if either the workflow itself reports terminal OR every step is
        // already reported. The OR-by-step path covers cases where the
        // orchestrator omits `status` on the workflow envelope.
        const allStepsReported = batch.stepNameToKey.size === batch.reported.size;
        if (TERMINAL_WORKFLOW_STATUSES.has(wf.status ?? '') || allStepsReported) {
          pending.delete(polledId);
        }
      });

      if (pending.size > 0) await sleep(POLL_INTERVAL_MS, signal);
    }

    if (isStillActive()) opts.onDone?.({ successes, failedKeys: Array.from(failedKeys) });
  };

  // If every upload failed there's nothing to poll — emit done synchronously
  // so the caller's spinner doesn't hang forever.
  if (submittedBatches.length === 0) {
    if (isStillActive()) opts.onDone?.({ successes, failedKeys: Array.from(failedKeys) });
  } else {
    poll().catch((err) => {
      if (isAbort(err)) return;
      // Catastrophic poll failure (not per-image): surface separately so the
      // UI can show a real error toast instead of pretending it was a
      // per-image failure.
      const reason = describeError(err);
      opts.onFatal?.(reason);
      if (isStillActive()) opts.onDone?.({ successes, failedKeys: Array.from(failedKeys) });
    });
  }

  return {
    workflowIds: submittedBatches.map((b) => b.workflowId),
    cancel: () => internal.abort(),
  };
}
