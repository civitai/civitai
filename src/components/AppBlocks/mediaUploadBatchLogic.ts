/**
 * `OPEN_MEDIA_UPLOAD_BATCH` → `MEDIA_UPLOAD_BATCH_RESULT`: the pure half of a page block uploading
 * many files it holds as PRIVATE generation inputs (orchestrator consumer blobs), behind ONE confirm
 * in host chrome. Each item is checked exactly as a single `OPEN_MEDIA_UPLOAD { bytes }` is
 * (`checkMediaUploadBytes`), but there is no per-minute window: the viewer's confirm gates the
 * batch, and the server's daily quota bounds it.
 *
 * The SDK's mock host (`@civitai/blocks-react`, `mediaUploadBytes.ts`) copies these limits and
 * error strings so a block test accepts and refuses what production does; change both.
 */

import {
  MEDIA_UPLOAD_BATCH_MAX_BYTES,
  MEDIA_UPLOAD_BATCH_MAX_ITEMS,
  MEDIA_UPLOAD_BATCH_TOO_LARGE_ERROR,
} from '~/shared/constants/media-upload-batch.constants';
import {
  MEDIA_UPLOAD_FAILED_ERROR,
  MEDIA_UPLOAD_INVALID_ERROR,
  MEDIA_UPLOAD_KIND_ERROR,
  MEDIA_UPLOAD_KINDS,
  MEDIA_UPLOAD_MAX_BYTES_BY_KIND,
  MEDIA_UPLOAD_PURPOSE_ERROR,
  MEDIA_UPLOAD_TOO_LARGE_ERROR,
  checkMediaUploadBytes,
  type BlockMediaUploadInfo,
  type MediaUploadKind,
} from './mediaUploadLogic';

export const MEDIA_UPLOAD_BATCH_INVALID_ERROR = 'invalid media-upload batch request';
export const MEDIA_UPLOAD_BATCH_COUNT_ERROR = `a batch holds 1 to ${MEDIA_UPLOAD_BATCH_MAX_ITEMS} files`;
export { MEDIA_UPLOAD_BATCH_TOO_LARGE_ERROR };

/** One item that passed the per-file checks, ready to upload. */
export type MediaUploadBatchFile = {
  index: number;
  kind: MediaUploadKind;
  bytes: ArrayBuffer;
  contentType: string;
};

export type MediaUploadBatchItemResult =
  | { index: number; selected: BlockMediaUploadInfo }
  | { index: number; error: string };

export type MediaUploadBatchPlan = {
  requestId: string;
  /** One slot per item, in item order: a refusal already decided, or `null` until it uploads. */
  refusals: Array<string | null>;
  /** The items that will upload once the viewer confirms. */
  files: MediaUploadBatchFile[];
};

export type MediaUploadBatchDecision =
  | { kind: 'drop' }
  | { kind: 'refuse'; requestId: string; error: string }
  | { kind: 'ok'; plan: MediaUploadBatchPlan };

/** One item's per-file checks, in the single bytes upload's order minus its window. */
function checkItem(
  raw: unknown
): { ok: true; file: Omit<MediaUploadBatchFile, 'index'> } | { ok: false; error: string } {
  const r = raw as Record<string, unknown>;
  if (!(MEDIA_UPLOAD_KINDS as readonly unknown[]).includes(r.kind)) {
    return { ok: false, error: MEDIA_UPLOAD_KIND_ERROR };
  }
  const kind = r.kind as MediaUploadKind;
  if (!(r.bytes instanceof ArrayBuffer) || r.bytes.byteLength === 0) {
    return { ok: false, error: MEDIA_UPLOAD_INVALID_ERROR };
  }
  if (r.mimeType !== undefined && typeof r.mimeType !== 'string') {
    return { ok: false, error: MEDIA_UPLOAD_INVALID_ERROR };
  }
  const bytes = r.bytes;
  if (bytes.byteLength > MEDIA_UPLOAD_MAX_BYTES_BY_KIND[kind]) {
    return { ok: false, error: MEDIA_UPLOAD_TOO_LARGE_ERROR[kind] };
  }
  const checked = checkMediaUploadBytes({
    kind,
    bytes,
    mimeType: r.mimeType as string | undefined,
  });
  if (!checked.ok) return checked;
  return { ok: true, file: { kind, bytes, contentType: checked.contentType } };
}

/**
 * Parse and check a raw `OPEN_MEDIA_UPLOAD_BATCH` payload. `drop` = no usable requestId, so no
 * reply can be correlated. A whole-batch refusal (shape, purpose, count, total size) uploads
 * nothing; a per-item refusal is answered for that item only.
 */
export function resolveMediaUploadBatchRequest(raw: unknown): MediaUploadBatchDecision {
  if (!raw || typeof raw !== 'object') return { kind: 'drop' };
  const r = raw as Record<string, unknown>;
  if (typeof r.requestId !== 'string' || r.requestId.length === 0) return { kind: 'drop' };
  const requestId = r.requestId;
  const refuse = (error: string) => ({ kind: 'refuse' as const, requestId, error });
  if (r.purpose !== 'generationSource') return refuse(MEDIA_UPLOAD_PURPOSE_ERROR);
  if (!Array.isArray(r.items)) return refuse(MEDIA_UPLOAD_BATCH_INVALID_ERROR);
  if (r.items.some((item) => !item || typeof item !== 'object')) {
    return refuse(MEDIA_UPLOAD_BATCH_INVALID_ERROR);
  }
  if (r.items.length === 0 || r.items.length > MEDIA_UPLOAD_BATCH_MAX_ITEMS) {
    return refuse(MEDIA_UPLOAD_BATCH_COUNT_ERROR);
  }
  const total = r.items.reduce<number>((sum, item) => {
    const bytes = (item as { bytes?: unknown }).bytes;
    return sum + (bytes instanceof ArrayBuffer ? bytes.byteLength : 0);
  }, 0);
  if (total > MEDIA_UPLOAD_BATCH_MAX_BYTES) return refuse(MEDIA_UPLOAD_BATCH_TOO_LARGE_ERROR);

  const refusals: Array<string | null> = [];
  const files: MediaUploadBatchFile[] = [];
  r.items.forEach((item, index) => {
    const checked = checkItem(item);
    if (checked.ok) {
      refusals.push(null);
      files.push({ index, ...checked.file });
    } else {
      refusals.push(checked.error);
    }
  });
  return { kind: 'ok', plan: { requestId, refusals, files } };
}

const KIND_NOUN: Record<MediaUploadKind, [string, string]> = {
  image: ['image', 'images'],
  video: ['video', 'videos'],
  audio: ['audio file', 'audio files'],
};

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb).toLocaleString('en-US')} MB`;
}

/**
 * The host's own confirm, e.g. `Upload 80 images (312 MB) for “Caption Studio”?`. Everything in it
 * is counted by the host from the bytes it holds; the app's name is the listing's.
 */
export function buildMediaUploadBatchConfirmCopy(args: {
  appName: string | null | undefined;
  files: readonly Pick<MediaUploadBatchFile, 'kind' | 'bytes'>[];
}): { title: string; message: string; confirmLabel: string } {
  const count = args.files.length;
  const kinds = new Set(args.files.map((f) => f.kind));
  const [one, many] =
    kinds.size === 1 ? KIND_NOUN[[...kinds][0]] : (['file', 'files'] as [string, string]);
  const bytes = args.files.reduce((sum, f) => sum + f.bytes.byteLength, 0);
  const noun = `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
  const app = args.appName ? `“${args.appName}”` : 'this app';
  return {
    title: 'Upload files?',
    message: `Upload ${noun} (${formatMegabytes(
      bytes
    )}) for ${app}? They are uploaded privately to your account, checked by our content scan, and kept for at least 30 days.`,
    confirmLabel: 'Upload',
  };
}

/**
 * Runs `task` over `items` with at most `limit` running at once, in item order, and resolves once
 * every one has settled. `task` must not throw; a refusal is its own result.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The batch's per-item answer, in item order: each item's refusal, else its upload result. */
export function buildMediaUploadBatchResults(
  plan: Pick<MediaUploadBatchPlan, 'refusals'>,
  uploaded: ReadonlyMap<number, MediaUploadBatchItemResult>
): MediaUploadBatchItemResult[] {
  return plan.refusals.map((refusal, index) =>
    refusal !== null
      ? { index, error: refusal }
      : uploaded.get(index) ?? { index, error: MEDIA_UPLOAD_FAILED_ERROR }
  );
}

const RELAYED_START_CODES = new Set([
  'TOO_MANY_REQUESTS',
  'FORBIDDEN',
  'PRECONDITION_FAILED',
  'UNAUTHORIZED',
  'SERVICE_UNAVAILABLE',
]);

/**
 * The block's message when the server refused to start a batch. The quota, flag, session and
 * not-yet-available refusals are written for the viewer and relayed; anything else gets a fixed
 * message, since its text was not written for the app.
 */
export function mediaUploadBatchStartError(err: unknown): string {
  const code = (err as { data?: { code?: unknown } } | null)?.data?.code;
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof code === 'string' && RELAYED_START_CODES.has(code) && typeof message === 'string') {
    return message;
  }
  return MEDIA_UPLOAD_FAILED_ERROR;
}

function httpStatusOf(err: unknown): number | undefined {
  const status = (err as { data?: { httpStatus?: unknown } } | null)?.data?.httpStatus;
  return typeof status === 'number' ? status : undefined;
}

function isUnauthorized(err: unknown): boolean {
  const code = (err as { data?: { code?: unknown } } | null)?.data?.code;
  return httpStatusOf(err) === 401 || code === 'UNAUTHORIZED';
}

/**
 * Runs `call` with the host's CURRENT block token, read through `readToken` at the moment of the
 * call: a batch can outlive the token it started with (the host refreshes a page token before it
 * expires). A refusal as UNAUTHORIZED is retried once with the token read again, for a refresh that
 * landed between the read and the call.
 */
export async function callWithCurrentToken<T>(
  readToken: () => string | null | undefined,
  call: (blockToken: string) => Promise<T>
): Promise<T> {
  const first = readToken();
  if (!first) throw new Error('no block token');
  try {
    return await call(first);
  } catch (err) {
    if (!isUnauthorized(err)) throw err;
    const again = readToken();
    if (!again) throw err;
    return call(again);
  }
}

/** Waits before the 2nd and 3rd attempt at recording an uploaded file. */
export const MEDIA_UPLOAD_BATCH_RECORD_RETRY_DELAYS_MS = [500, 1500] as const;

/**
 * Records an uploaded file, retrying a server error (5xx), a 429 or a network failure (no HTTP
 * status) up to 3 attempts in all. A refusal (any other 4xx) is final at once. The last failure is
 * thrown: the caller answers that item with an error, and the uploaded file is then missing from
 * the batch's audit row.
 */
export async function retryMediaUploadBatchRecord<T>(
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const status = httpStatusOf(err);
      const retryable = status === undefined || status === 429 || status >= 500;
      const delay = MEDIA_UPLOAD_BATCH_RECORD_RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}
