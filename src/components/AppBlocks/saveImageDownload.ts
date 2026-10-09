/**
 * App Blocks `SAVE_IMAGE` download bridge — the PURE, unit-testable core.
 *
 * A block rendered in the unverified sandbox (`allow-scripts allow-forms`, NO
 * `allow-downloads`, opaque origin) cannot trigger a browser "Save As" of an
 * image it displays — only copy-URL works. This module backs the host handler
 * that does the download in the UNSANDBOXED top frame on the block's behalf.
 *
 * SECURITY: the block never gets to name an arbitrary host to fetch. There are
 * three request variants and each has its own gate (see PageBlockHost's handler):
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
 *   - `bytes`   — a file the block produced in its tab (an `ArrayBuffer`). Nothing
 *                 is fetched; the type is classified from the CONTENT
 *                 ({@link classifySaveBytes}) — never the caller's mimeType or
 *                 filename — so only PNG / WebP / JPEG / JSON / plain text can be
 *                 saved, always under that type's own extension.
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
  // Same hostname as the default of `NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT` (src/env/client-schema.ts),
  // for a different reason: there it is the base URL the browser CALLS, here it is a host this
  // bridge may FETCH from. Keep them separate — but a blob URL minted by that origin must be
  // fetchable here, so if the public orchestrator host changes, this entry changes with it. Asserted
  // in src/__tests__/pages/training-studio-embed-orchestrator-origin.test.ts. This list may legally
  // hold MORE hosts than that one origin (an old host kept fetchable across a migration, the image
  // CDN); it may not hold fewer.
  'orchestration.civitai.com',
  // The LIVE orchestrator's public origin — note `-new`, NOT `-next`. This is the host production
  // actually mints consumer-blob URLs on (`/v2/consumer/blobs/<uuid>-<n>.jpg?sig=…&exp=…`), so
  // every App Block output a viewer pays for arrives on it. Omitting it made
  // `isAllowedSaveImageUrl` return false for all of them and the host reply `image url is not
  // allowed` (PageBlockHost.tsx:3609) — the viewer's ONLY save route, since `<a download>` is inert
  // in the block's sandbox. Not the default of `NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT` (that is still
  // `orchestration.civitai.com`), so the one-directional assertion in
  // src/__tests__/pages/training-studio-embed-orchestrator-origin.test.ts does not require it; it is
  // here because the blobs are here. Already trusted by the sibling allowlist
  // `KNOWN_ORCHESTRATOR_HOSTS` (src/server/services/orchestrator/trusted-blob-url.ts), which is
  // where to look if either list changes. Resolves and serves today (verified 2026-10-01); per that
  // file's rule, drop it if it ever stops resolving.
  'orchestration-new.civitai.com',
  // The "next" orchestrator's public origin. Not the default of
  // `NEXT_PUBLIC_ORCHESTRATOR_ENDPOINT`, so the one-directional assertion in the
  // test above does not require it — but a preview opted onto that orchestrator
  // browses against this origin, and a blob URL it mints has to be fetchable
  // here for the same reason the entry above exists. The list may legally hold
  // more hosts than that one origin; this is one of them.
  'orchestration-next.civitai.com',
];

/** Bound the host-side blob fetch so a hostile block can't pull an unbounded video. */
export const SAVE_IMAGE_MAX_BYTES = 200 * 1024 * 1024; // 200 MB

/** Lower than the url cap: `bytes` are copied across frames into the viewer's tab memory, not streamed. */
export const SAVE_BYTES_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * F2 — max concurrent host-side SAVE_IMAGE downloads per host frame. The host
 * fetches on the block's behalf in the unsandboxed top frame; without a cap a
 * hostile block could fire a burst of SAVE_IMAGEs and download-bomb the viewer's
 * tab (memory / bandwidth). The host gates on this and replies `busy` past it.
 */
export const SAVE_IMAGE_MAX_CONCURRENT = 3;

/**
 * F2 — canonical download extension per resolved content type. Bytes fetched
 * host-side are constrained to a SAFE MEDIA extension (see
 * {@link enforceImageExtension}) so a block can't save an orchestration blob under
 * an arbitrary/executable name (`render.html`, `x.exe`). Deliberately EXCLUDES
 * `image/svg+xml` — an SVG is scriptable, so it never gets an `.svg` download name.
 */
const CONTENT_TYPE_TO_EXT: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/apng': 'apng',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** Extensions we allow a supplied filename to KEEP when the content type is unknown. */
const SAFE_MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.values(CONTENT_TYPE_TO_EXT).concat('jpeg')
);

/** Fallback download extension when the content type is unknown and the name has no safe one. */
const DEFAULT_SAFE_EXTENSION = 'jpg';

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

/**
 * F2 — constrain a (already-sanitized) download filename to a SAFE MEDIA extension
 * derived from the RESOLVED content type of the fetched bytes. This is the
 * download-name analogue of the origin allowlist: the origin gate stops the host
 * fetching an attacker URL; this stops a block naming allowlisted image/blob bytes
 * `render.html` / `x.exe` so a "Save image" can never write an executable/markup
 * extension the OS or a later open would treat as such.
 *
 * Rules:
 *   • Known content type → force its canonical extension (`image/png` → `.png`),
 *     unless the name already carries that exact/alias extension (jpeg≡jpg), in
 *     which case the name is kept verbatim. Internal dots are preserved.
 *   • Unknown content type → keep the name IFF its current extension is already a
 *     safe media extension; otherwise coerce to {@link DEFAULT_SAFE_EXTENSION}.
 * `sanitizeDownloadFilename` (traversal/query strip) runs FIRST; this only touches
 * the extension.
 */
export function enforceImageExtension(filename: string, contentType?: string | null): string {
  const name = filename && filename.trim().length > 0 ? filename.trim() : 'download';
  const m = name.match(/^(.*)\.([a-zA-Z0-9]{1,5})$/);
  const base = m ? m[1] : name;
  const currentExt = m ? m[2].toLowerCase() : '';

  const normalizedType = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const canonical = CONTENT_TYPE_TO_EXT[normalizedType];

  if (canonical) {
    const aliasOk = currentExt === canonical || (canonical === 'jpg' && currentExt === 'jpeg');
    return aliasOk ? name : `${base}.${canonical}`;
  }
  // Unknown content type: keep an already-safe extension, else force the default.
  if (currentExt && SAFE_MEDIA_EXTENSIONS.has(currentExt)) return name;
  return `${base}.${DEFAULT_SAFE_EXTENSION}`;
}

/** Parsed, validated SAVE_IMAGE request. Exactly one of url / imageId / bytes is set. */
export type SaveImageRequest =
  | { requestId: string; kind: 'url'; url: string; filename?: string }
  | { requestId: string; kind: 'id'; imageId: number; filename?: string }
  | {
      requestId: string;
      kind: 'bytes';
      bytes: ArrayBuffer;
      filename?: string;
      mimeType?: string;
    };

/**
 * Parse a raw inbound SAVE_IMAGE payload into a discriminated request, or `null`
 * when it's unusable (missing/invalid requestId, or NOT exactly one of
 * url/imageId/bytes). Pure — no allowlist / no DOM — so the message-shape contract is
 * unit-testable independently of the origin gate + the download. A `null` return
 * means "drop, no reply" (a missing requestId can't be correlated); a shape that
 * HAS a requestId but is otherwise invalid returns a request the caller NACKs.
 */
export function resolveSaveImageRequest(
  raw: unknown
): SaveImageRequest | { requestId: string; kind: 'invalid' } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    requestId?: unknown;
    url?: unknown;
    imageId?: unknown;
    bytes?: unknown;
    filename?: unknown;
    mimeType?: unknown;
  };
  if (typeof r.requestId !== 'string' || r.requestId.length === 0) return null;
  const filename = typeof r.filename === 'string' ? r.filename : undefined;
  if (r.bytes != null) {
    // Any url/imageId alongside bytes is ambiguous, whether or not it would be valid on its own.
    // A typed-array view is refused rather than unwrapped: its window into `.buffer` is not the file.
    if (r.url != null || r.imageId != null) return { requestId: r.requestId, kind: 'invalid' };
    if (!(r.bytes instanceof ArrayBuffer) || r.bytes.byteLength === 0) {
      return { requestId: r.requestId, kind: 'invalid' };
    }
    return {
      requestId: r.requestId,
      kind: 'bytes',
      bytes: r.bytes,
      filename,
      mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
    };
  }
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
 *
 * F3 (documented client-side limitation): XHR transparently FOLLOWS HTTP
 * redirects, and {@link isAllowedSaveImageUrl} only gates the INITIAL url — a
 * first-party (allowlisted) host that itself issues an open redirect could land
 * the fetch on another origin. This is accepted for v1: the allowlist is the
 * civitai image/blob CDN, which does not open-redirect; a stricter check would
 * need a HEAD/redirect-manual pre-flight (not worth it for the same-origin CDN).
 * The bytes are additionally bounded by the size cap + the safe-extension gate.
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

  // F2: constrain the saved name to a safe media extension keyed on the RESOLVED
  // content type of the fetched bytes (a block can't save a blob as render.html).
  triggerBlobDownload(blob, enforceImageExtension(filename, blob?.type));
}

/** Object URL + `<a download>` in the top frame, revoked afterwards. */
function triggerBlobDownload(blob: Blob, safeFilename: string): void {
  const href = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = href;
    a.download = safeFilename;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(href);
  }
}

/** The only types a `bytes` save can be classified as, each with the one extension it saves under. */
const SAVE_BYTES_EXTENSION = {
  'image/png': 'png',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'application/json': 'json',
  'text/plain': 'txt',
} as const;

export type SaveBytesType = keyof typeof SAVE_BYTES_EXTENSION;

export const SAVE_BYTES_TOO_LARGE_ERROR = 'file exceeds the maximum save size';
export const SAVE_BYTES_TYPE_NOT_ALLOWED_ERROR = 'file type is not allowed';

/**
 * Client-side copy of `sniffSupportedImage` (block-image-upload.service.ts), which is server-only.
 * Deliberately narrower: no GIF, and the full 8-byte PNG signature.
 */
function sniffSaveBytesImage(b: Uint8Array): SaveBytesType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= png.length && png.every((v, i) => b[i] === v)) return 'image/png';
  const riff = [0x52, 0x49, 0x46, 0x46];
  const webp = [0x57, 0x45, 0x42, 0x50];
  if (b.length >= 12 && riff.every((v, i) => b[i] === v) && webp.every((v, i) => b[8 + i] === v)) {
    return 'image/webp';
  }
  return null;
}

/**
 * Classify block-supplied bytes by CONTENT. The caller's `mimeType` / `filename` only choose
 * between JSON and plain text for bytes that are already valid UTF-8 text; they can never make
 * anything else saveable. `null` = not a saveable type (GIF, archives, executables, binary).
 */
export function classifySaveBytes(
  bytes: ArrayBuffer,
  hint: { mimeType?: string; filename?: string } = {}
): SaveBytesType | null {
  const u8 = new Uint8Array(bytes);
  if (u8.length === 0) return null;
  const image = sniffSaveBytesImage(u8);
  if (image) return image;
  if (u8.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    return null;
  }
  const hintedJson =
    (hint.mimeType ?? '').split(';')[0].trim().toLowerCase() === 'application/json' ||
    (hint.filename ?? '').toLowerCase().endsWith('.json');
  if (hintedJson) {
    try {
      JSON.parse(text);
      return 'application/json';
    } catch {
      // not JSON after all — falls through to plain text
    }
  }
  return 'text/plain';
}

/**
 * Replace whatever extension `filename` carries with the classified type's own, so a block can
 * never save `x.html` / `x.exe` / `x.svg`. Also drops control and bidi-override characters, which
 * can make a name display with a different extension than the one it has.
 */
export function forceSaveBytesExtension(filename: string, type: SaveBytesType): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = filename.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim();
  const name = cleaned.length > 0 ? cleaned : 'download';
  const m = name.match(/^(.+)\.([a-zA-Z0-9]{1,5})$/);
  return `${m ? m[1] : name}.${SAVE_BYTES_EXTENSION[type]}`;
}

/** Size-cap, classify and name a `bytes` save — every refusal is the reply's error string. */
export function prepareSaveBytes(req: {
  bytes: ArrayBuffer;
  filename?: string;
  mimeType?: string;
}): { ok: true; type: SaveBytesType; filename: string } | { ok: false; error: string } {
  if (req.bytes.byteLength > SAVE_BYTES_MAX_BYTES) {
    return { ok: false, error: SAVE_BYTES_TOO_LARGE_ERROR };
  }
  const filename = sanitizeDownloadFilename(req.filename, 'download');
  const type = classifySaveBytes(req.bytes, { mimeType: req.mimeType, filename });
  if (!type) return { ok: false, error: SAVE_BYTES_TYPE_NOT_ALLOWED_ERROR };
  return { ok: true, type, filename: forceSaveBytesExtension(filename, type) };
}

/** Build the Blob in the host frame with the CLASSIFIED type (never the caller's) and download it. */
export function downloadBytesAsBlob(bytes: ArrayBuffer, type: SaveBytesType, filename: string) {
  triggerBlobDownload(new Blob([bytes], { type }), filename);
}
