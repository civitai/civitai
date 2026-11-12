// Anti-hang ceiling only: a hung upstream would otherwise park the request for
// undici's ~300s default. Generous by design — callers downloading large media
// (video/zip) pass a bigger timeoutMs rather than risk cutting off a slow-but-legit transfer.
/** Idle gap that fails a generator media import: long videos are large, so no total cap. */
export const MEDIA_IDLE_TIMEOUT_MS = 30_000;

export class IdleTimeoutError extends Error {
  name = 'IdleTimeoutError';
}

/**
 * Fetches `src` into memory. By default `timeoutMs` caps the whole request, body included, and any
 * failure reading the body resolves `null`; server jobs size their leases on that cap.
 *
 * With `idleTimeoutMs`, `timeoutMs` only bounds the wait for the response headers. The body then
 * has no total cap and fails only after `idleTimeoutMs` with no bytes, so a large file on a slow
 * link finishes. A body failure rejects (`IdleTimeoutError`, or the read error) instead of
 * resolving `null`, so the caller can tell what went wrong.
 */
export async function fetchBlob(
  src: string | Blob | File,
  timeoutMs = 120_000,
  { requireOk = false, idleTimeoutMs }: { requireOk?: boolean; idleTimeoutMs?: number } = {}
) {
  if (src instanceof Blob) return src;
  if (idleTimeoutMs) return fetchBlobWithIdleTimeout(src, timeoutMs, idleTimeoutMs, requireOk);
  // Intentionally NOT behind the hot-path-fetch-timeouts Flipt kill-switch: this
  // is isomorphic (bundled client-side) so it can't import the server-only
  // isFliptSync, and its callers are background/media downloads where an abort is benign.
  // credentials:'omit' — every caller fetches cross-origin presigned/orchestrator/CDN
  // media (cookies were already not being sent under the same-origin default) or a
  // user/attacker-supplied URL that must never ride the victim's session. There is no
  // legit same-origin media fetch through this helper; if one ever appears it should be
  // an explicit, credentialed call site — not this helper. (ClickUp 868maend5)
  else
    return await fetch(src, { signal: AbortSignal.timeout(timeoutMs), credentials: 'omit' }).then(
      (response) => (requireOk && !response.ok ? null : response.blob().catch(() => null))
    );
}

async function fetchBlobWithIdleTimeout(
  src: string,
  headerTimeoutMs: number,
  idleTimeoutMs: number,
  requireOk: boolean
) {
  const controller = new AbortController();
  const headerTimer = setTimeout(
    () => controller.abort(new DOMException('No response before the deadline', 'TimeoutError')),
    headerTimeoutMs
  );
  let response: Response;
  try {
    // credentials: 'omit' for the same reason as the default path below.
    response = await fetch(src, { signal: controller.signal, credentials: 'omit' });
  } finally {
    clearTimeout(headerTimer);
  }
  if (requireOk && !response.ok) {
    controller.abort();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return response.blob();

  const chunks: Uint8Array[] = [];
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const idle = new IdleTimeoutError(`No bytes for ${idleTimeoutMs}ms`);
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(idle), idleTimeoutMs);
  };
  try {
    armIdle();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      armIdle();
    }
  } catch (e) {
    throw controller.signal.reason === idle ? idle : e;
  } finally {
    clearTimeout(idleTimer);
  }
  return new Blob(chunks as BlobPart[], { type: response.headers.get('content-type') ?? '' });
}

/** Trigger a browser download for the given blob with the provided filename. */
export function downloadBlob(blob: Blob, filename: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking in the same tick can cancel a large download before the browser has read it.
  setTimeout(() => URL.revokeObjectURL(href), 40_000);
}

/** Extension from a blob's content type (`image/svg+xml` -> `svg`); `fallback` when the type is missing or `application/octet-stream`. */
export function blobExtension(blob: Blob, fallback: string) {
  const subtype = blob.type.split(';')[0]!.split('/')[1]?.split('+')[0]?.trim();
  if (!subtype || subtype === 'octet-stream') return fallback;
  return subtype === 'jpeg' ? 'jpg' : subtype;
}

export function blobToFile(
  blob: Blob,
  filename = new Date().getTime().toString(),
  type = blob.type
) {
  return new File([blob], filename, { type });
}

export async function fetchBlobAsFile(
  src: string | Blob | File,
  filename?: string,
  options?: { requireOk?: boolean; idleTimeoutMs?: number }
) {
  if (src instanceof File) return src;
  const blob = await fetchBlob(src, undefined, options);
  if (!blob) return null;
  let type = blob.type;

  // have to do this to handle cases where content-type is application/octet-stream
  if (typeof src === 'string') {
    if (src.endsWith('.mp4')) type = 'video/mp4';
    else if (src.endsWith('.jpg') || src.endsWith('.jpeg')) type = 'image/jpeg';
  }
  return blobToFile(blob, filename, type);
}

export async function fetchBlobAsBase64(src: string | Blob | File) {
  const blob = await fetchBlob(src);
  if (!blob) return null;
  return getBase64(blob);
}

export const getBase64 = (blob: Blob | File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (!reader.result) throw new Error('failed to read blob');
      const base64 =
        typeof reader.result === 'string' ? reader.result : new TextDecoder().decode(reader.result);
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
