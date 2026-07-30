/**
 * App Blocks `SAVE_IMAGE` download bridge — the PURE, unit-testable core.
 *
 * A block rendered in the unverified sandbox (`allow-scripts allow-forms`, NO
 * `allow-downloads`, opaque origin) cannot trigger a browser "Save As" of an
 * image it displays — only copy-URL works. This module backs the host handler
 * that does the download in the UNSANDBOXED top frame on the block's behalf.
 *
 * SECURITY: the block never gets to name an arbitrary host to fetch. There are
 * two request variants and each has its own gate (see PageBlockHost's handler):
 *   - `url`     — the block's OWN output (an orchestration blob it has no image
 *                 id for). MUST pass {@link isAllowedSaveImageUrl} — an origin
 *                 allowlist over the civitai image/blob CDN. An arbitrary host,
 *                 a `data:` / `blob:` / `file:` URL, or plain `http:` is
 *                 REFUSED — never a host-side fetch of an attacker origin (the
 *                 same lesson as "raw block `data` URLs are untrusted").
 *   - `imageId` — a cross-user grid image. Resolved host-side through the SAME
 *                 gated per-viewer read that backs `GET_IMAGES_BY_IDS`, so a
 *                 withheld image can never be coerced into a download. The url it
 *                 yields is a civitai edge url — which ALSO satisfies the
 *                 allowlist, so the download step is uniform.
 */

/**
 * Civitai-owned image / orchestration-blob hostnames the download bridge may
 * fetch. These are PUBLIC product domains (they already appear throughout the
 * open-source civitai app + its config), not infra internals. The configured
 * image CDN origin (`NEXT_PUBLIC_IMAGE_LOCATION`) is added on top at call time,
 * so a non-prod/self-hosted deployment's CDN is covered without editing this.
 */
export const CIVITAI_IMAGE_HOSTS: readonly string[] = [
  'image.civitai.com',
  'orchestration.civitai.com',
];

/** Bound the host-side blob fetch so a hostile block can't pull an unbounded video. */
export const SAVE_IMAGE_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * True iff `rawUrl` is a civitai-served image/blob URL the host may fetch+download.
 *
 * Rules (fail-closed): must PARSE as a URL, must be `https:` (rejects
 * `data:`/`blob:`/`file:`/`http:` — an opaque-origin block's own `data` URL is
 * untrusted, and http would allow a downgrade/MITM download), and its hostname
 * must be an EXACT match in the allowlist — {@link CIVITAI_IMAGE_HOSTS} plus the
 * hostname of `imageCdnLocation` (the deployment's configured image CDN origin,
 * e.g. `NEXT_PUBLIC_IMAGE_LOCATION`). No subdomain/suffix wildcarding.
 *
 * @param rawUrl            the URL the block asked to save (its own output)
 * @param imageCdnLocation  the configured image CDN base (absolute URL) or ''
 */
export function isAllowedSaveImageUrl(rawUrl: unknown, imageCdnLocation: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  // https only — drops data:/blob:/file: and plain http:.
  if (u.protocol !== 'https:') return false;
  const allowed = new Set<string>(CIVITAI_IMAGE_HOSTS);
  if (imageCdnLocation) {
    try {
      allowed.add(new URL(imageCdnLocation).hostname);
    } catch {
      /* an unset / relative NEXT_PUBLIC_IMAGE_LOCATION contributes nothing */
    }
  }
  return allowed.has(u.hostname);
}

/**
 * Sanitize a download filename — LIFTED from `~/components/Image/DownloadImage`
 * (kept behavior-identical) so the bridge and the on-site component share ONE
 * cleaner. Strips a query/fragment, collapses a duplicate trailing extension
 * (`file.mp4.mp4` → `file.mp4`) while preserving dots in the base name, and —
 * the bridge-specific hardening — drops any path separators / traversal so a
 * block-supplied `filename` can never write outside the download name (`a/../b`
 * → `b`). Falls back to the URL's last path segment, then a generic name.
 */
export function sanitizeDownloadFilename(name: string | undefined | null, url: string): string {
  let cleanFilename = (name ?? url.split('/').pop() ?? 'download').toString();
  // Drop any directory component / traversal (block-supplied names are untrusted).
  cleanFilename = cleanFilename.split(/[\\/]/).pop() ?? cleanFilename;
  // Strip query params and fragments.
  cleanFilename = cleanFilename.split('?')[0].split('#')[0];
  // Collapse a duplicated trailing extension (token-appended), preserving base dots.
  const extMatch = cleanFilename.match(/\.([a-zA-Z0-9]{2,5})$/);
  if (extMatch) {
    const ext = extMatch[1];
    const dupePattern = new RegExp(`(\\.${ext})+$`);
    cleanFilename = cleanFilename.replace(dupePattern, `.${ext}`);
  }
  cleanFilename = cleanFilename.trim();
  return cleanFilename.length > 0 ? cleanFilename : 'download';
}

/** Parsed, validated SAVE_IMAGE request. Exactly one of url / imageId is set. */
export type SaveImageRequest =
  | { requestId: string; kind: 'url'; url: string; filename?: string }
  | { requestId: string; kind: 'id'; imageId: number; filename?: string };

/**
 * Parse a raw inbound SAVE_IMAGE payload into a discriminated request, or `null`
 * when it's unusable (missing/invalid requestId, or NOT exactly one of
 * url/imageId). Pure — no allowlist / no DOM — so the message-shape contract is
 * unit-testable independently of the origin gate + the download. A `null` return
 * means "drop, no reply" (a missing requestId can't be correlated); a shape that
 * HAS a requestId but is otherwise invalid returns a request the caller NACKs.
 */
export function resolveSaveImageRequest(raw: unknown): SaveImageRequest | { requestId: string; kind: 'invalid' } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { requestId?: unknown; url?: unknown; imageId?: unknown; filename?: unknown };
  if (typeof r.requestId !== 'string' || r.requestId.length === 0) return null;
  const filename = typeof r.filename === 'string' ? r.filename : undefined;
  const hasUrl = typeof r.url === 'string' && r.url.length > 0;
  const hasId = typeof r.imageId === 'number' && Number.isInteger(r.imageId) && r.imageId > 0;
  // Exactly one variant. Both-or-neither is an invalid (NACK-able) request.
  if (hasUrl === hasId) return { requestId: r.requestId, kind: 'invalid' };
  if (hasUrl) return { requestId: r.requestId, kind: 'url', url: r.url as string, filename };
  return { requestId: r.requestId, kind: 'id', imageId: r.imageId as number, filename };
}

/**
 * Fetch `url` as a blob in the TOP frame (host document — not the sandboxed
 * iframe) and trigger a browser download. Runs the same XHR→blob→`<a download>`
 * path as `~/components/Image/DownloadImage`, with a byte cap
 * ({@link SAVE_IMAGE_MAX_BYTES}) that aborts an over-size transfer. Resolves on
 * success, throws on failure (non-200, over-size, network). The CALLER is
 * responsible for having validated the origin ({@link isAllowedSaveImageUrl}) or
 * resolved it via the gated read BEFORE calling this.
 */
export async function downloadUrlAsBlob(
  url: string,
  filename: string,
  opts: { maxBytes?: number } = {}
): Promise<void> {
  const maxBytes = opts.maxBytes ?? SAVE_IMAGE_MAX_BYTES;
  const blob = await new Promise<Blob>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.responseType = 'blob';
    xhr.addEventListener('progress', ({ loaded, total }) => {
      // Abort as soon as a declared or streamed size blows the cap.
      if ((total && total > maxBytes) || loaded > maxBytes) {
        xhr.abort();
        reject(new Error('image exceeds the maximum download size'));
      }
    });
    xhr.addEventListener('loadend', () => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        const b = xhr.response as Blob;
        if (b && b.size > maxBytes) {
          reject(new Error('image exceeds the maximum download size'));
          return;
        }
        resolve(b);
      } else if (xhr.readyState === 4) {
        reject(new Error(`download failed (${xhr.status})`));
      }
    });
    xhr.addEventListener('error', () => reject(new Error('download failed')));
    xhr.addEventListener('abort', () => reject(new Error('download aborted')));
    xhr.open('GET', url);
    xhr.send();
  });

  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(href);
  }
}
