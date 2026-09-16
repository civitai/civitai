// Client-side dataset upload: mint a presigned URL through the backend seam, then POST the file straight
// to the orchestrator, which scans it and returns the registered blob. Mirrors the main app's per-image
// path (src/utils/training/auto-label-orchestrator.ts) — 2 hops, concurrency-limited, no zip.

import { backend } from '$lib/host';

/** The scanned blob the orchestrator returns from the upload POST. `url` is the media URL (absent until
 *  the blob is available / when blocked); `id` is the training-data reference. */
export interface UploadedBlob {
  id: string;
  url?: string | null;
  available: boolean;
  blockedReason?: string | null;
}

export class UploadError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'UploadError';
  }
  /** Re-uploading won't help: rejected by content policy (422), unsupported type (415), too large (413). */
  get permanent() {
    return this.status === 422 || this.status === 415 || this.status === 413;
  }
}

export const isAbort = (err: unknown) => (err as DOMException | undefined)?.name === 'AbortError';

/** Pull a short human line out of an error body, falling back to the raw text. Covers both the
 *  orchestrator's ProblemDetails (`title`/`detail`) and SvelteKit's `error()` shape (`message`). */
export function uploadProblem(text: string, status: number): string {
  try {
    const body = JSON.parse(text) as { title?: string; detail?: string; message?: string };
    const msg = body.detail ?? body.title ?? body.message;
    if (msg) return msg;
  } catch {
    // not JSON
  }
  const trimmed = text.trim();
  if (trimmed && trimmed.length < 200) return trimmed;
  return `Upload failed (${status})`;
}

async function presign(signal: AbortSignal): Promise<string> {
  const { uploadUrl } = await backend().uploadUrl(signal);
  return uploadUrl;
}

function post(
  uploadUrl: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal
): Promise<UploadedBlob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedBlob);
        } catch {
          reject(new UploadError(xhr.status, 'The upload response could not be read.'));
        }
      } else {
        reject(new UploadError(xhr.status, uploadProblem(xhr.responseText, xhr.status)));
      }
    };
    xhr.onerror = () => reject(new UploadError(0, 'Network error during upload.'));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

/** Upload one file end-to-end: presign → POST → scanned blob. Throws `UploadError` (or an AbortError). */
export async function uploadFile(
  file: File,
  onProgress: (fraction: number) => void,
  signal: AbortSignal
): Promise<UploadedBlob> {
  const uploadUrl = await presign(signal);
  const blob = await post(uploadUrl, file, onProgress, signal);
  if (!blob.url) {
    // A 2xx with a block reason is a content-policy rejection (permanent). A 2xx with neither url nor
    // reason is the rare "not yet retrievable" case — retryable, so don't assert a scan failure.
    if (blob.blockedReason) throw new UploadError(422, blob.blockedReason);
    throw new UploadError(0, 'Upload finished but the file is not ready yet — retry.');
  }
  return blob;
}
