import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { structuredPatch } from 'diff';
import JSZip from 'jszip';
import {
  MAX_BUNDLE_SIZE_BYTES,
  MAX_FILES_IN_BUNDLE,
  MAX_FILE_SIZE_BYTES,
  MAX_SCREENSHOT_SIZE_BYTES,
  MAX_SCREENSHOTS,
  MAX_TOTAL_DECOMPRESSED_BYTES,
  PUBLISH_REJECTION_REASON_MAX,
  PUBLISH_REJECTION_REASON_MIN,
  SCREENSHOT_DIR,
  SCREENSHOT_EXTENSIONS,
  type ScreenshotExtension,
} from '~/server/schema/blocks/publish-request.schema';
// Pure shared module (only depends on token-scope.constants) — safe to import
// statically without coupling to env/Prisma, so the pure-helper tests still run.
import {
  assertSensitiveScopesJustified,
  deriveOauthBitmaskFromBlockScopes,
} from '~/shared/constants/block-scope.constants';
// Pure (no env/Prisma) — stamps the platform-owned iframe.src onto a manifest.
import { stampCanonicalIframeSrc } from '~/server/services/blocks/manifest-normalize';
// Zero-runtime-graph helper (its ONLY static import is a type; it DYNAMICALLY imports
// the notifications client in its body). approve/reject call it POST-COMMIT to notify
// the submitting developer of the moderator decision — best-effort, wrapped in a
// try/catch at each call site so a notification failure can never fail the decision.
import { notifyAppBlockSubmitter } from '~/server/services/blocks/app-block-notify';
// Pure const (no env/Prisma) — the marketplace category taxonomy + type guard.
// approveRequest copies a validated manifest `category` onto AppBlock.category.
import { isMarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
// Type-only (erased at runtime) — the AppBlock projection the shared
// AppBlock→AppListing mapper consumes (see the (3b) auto-create block in
// approveRequest). The mapper VALUE itself is dynamically imported at use.
import type { SourceAppBlock } from '~/server/services/blocks/app-listing-mapper';
// Pure util (no env/Prisma) — folds a blockId to the appsDb schema slug. Used by
// the (3c) storage-provision-on-approve block; matches the admin backfill's
// derivation exactly. The provisioner VALUE is dynamically imported at use so
// appsDb/pg stay out of this module's static graph (mirrors the (3b) mapper).
import { sanitizeAppSlug } from '~/server/utils/apps-slug';
// Pure const (no env/Prisma). THE SAME threshold the owner-facing UI uses to call
// a deploy "stalled" — shared so the mod retrigger gate and the badge can never
// disagree about whether a build is stuck.
import {
  DEPLOY_PENDING_GRACE_MS,
  DEPLOY_STALE_AFTER_MS,
} from '~/shared/constants/app-block-deploy.constants';
// Pure, dependency-free sanitizer. Applied to EVERY value written to the
// owner-visible `deploy_detail`, so the "guaranteed printable, bounded text"
// invariant that module documents holds on all write paths — not just the
// build-callback's.
import { sanitizeBuildFailureReason } from './build-failure-reason';

// dbRead/dbWrite/newUlid/bundle-s3 are dynamically imported inside the
// functions that need them so the pure helpers (extract/diff) can be
// unit-tested without booting the env-coupled Prisma client.

/**
 * App Blocks W1 publish-request service.
 *
 * Pipeline:
 *   1. Decode base64 bundle, enforce size cap.
 *   2. Parse ZIP via jszip; enforce file-count + per-file size caps.
 *   3. Compute SHA256 of each file's contents (path → hash map).
 *   4. Extract block.manifest.json, parse, validate as JSON.
 *   5. Look up previous approved version (if any), pull its file map +
 *      manifest, compute file_summary + manifest_diff_summary.
 *   6. Upload bundle to MinIO at app-block-bundles/bundles/<sha256>.zip.
 *   7. Insert app_block_publish_requests row, status='pending'.
 *
 * Failure semantics: every fatal error throws a Service-level Error with
 * a human-readable message. The router translates these into TRPCErrors.
 * No partial-state leakage — MinIO put happens last, so a validation
 * failure never leaves dangling objects.
 *
 * Deferred to Phase 3+:
 *   - Cross-bundle dedup (the bundleSha256 index already supports this
 *     read-side; deferring the dedup write-path until we see the volume).
 *   - Discord notification on new pending request (Phase 6).
 *   - Rate limit per submitter (Phase 6).
 */

export type FileMeta = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

export type FileSummary = {
  files: FileMeta[];
  added: string[];
  removed: string[];
  changed: string[];
};

export type ManifestDiffSummary =
  | { kind: 'first-version'; fields: string[] }
  | {
      kind: 'update';
      added: string[];
      removed: string[];
      changed: Array<{ field: string; from: unknown; to: unknown }>;
    };

export type SubmitVersionParams = {
  bundleBuffer: Buffer;
  submittedByUserId: number;
};

export type SubmitVersionResult = {
  publishRequestId: string;
  slug: string;
  version: string;
  bundleSha256: string;
  fileSummary: FileSummary;
  manifestDiffSummary: ManifestDiffSummary;
};

const MANIFEST_PATH = 'block.manifest.json';

// Diff threshold: fields that exceed N bytes when serialized are summarised
// rather than embedded verbatim in the diff so manifestDiffSummary stays
// scannable in the mod-review UI.
const MAX_FIELD_VALUE_INLINE_BYTES = 2048;

/**
 * Stable JSON-serialisation hash for a manifest field value. Object keys
 * are sorted so { a: 1, b: 2 } and { b: 2, a: 1 } compare equal.
 */
function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) => `${JSON.stringify(k)}:${stableJsonStringify((value as Record<string, unknown>)[k])}`
    )
    .join(',')}}`;
}

/**
 * Truncate a JSON-serialisable value if it exceeds the inline cap. Used
 * by computeManifestDiff to keep large fields out of the queue UI without
 * losing the "this changed" signal.
 */
function summariseValue(value: unknown): unknown {
  const json = stableJsonStringify(value);
  if (json.length <= MAX_FIELD_VALUE_INLINE_BYTES) return value;
  return {
    __summarised: true,
    sha256: stableHash(value),
    sizeBytes: json.length,
    preview: json.slice(0, 200),
  };
}

/**
 * Stream-decompress a single jszip entry to a Buffer while enforcing both
 * a per-file cap AND a running global-budget cap. `entry.async('nodebuffer')`
 * fully materialises the decompressed bytes BEFORE any length check runs, so a
 * single entry that inflates to many GiB OOMs the pod before a post-hoc guard
 * can fire. Streaming via `entry.nodeStream` lets us abort the instant either
 * cap is breached, bounding resident memory to ~one per-file cap.
 *
 * `remainingTotalBytes` is the caller's running global budget (total cap minus
 * what earlier entries already consumed); the entry is rejected if its size
 * passes that too, which is the aggregate zip-bomb defense.
 *
 * Error messages preserve the existing per-file wording (`max <bytes>`) that a
 * test asserts; the aggregate breach uses a distinct, clear message.
 */
function readZipEntryCapped(
  entry: JSZip.JSZipObject,
  opts: { maxFileSizeBytes: number; remainingTotalBytes: number; maxTotalBytes: number; path: string }
): Promise<Buffer> {
  const { maxFileSizeBytes, remainingTotalBytes, maxTotalBytes, path } = opts;
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    // data events emit Buffer chunks for the 'nodebuffer' type.
    const stream = entry.nodeStream('nodebuffer');
    stream.on('data', (chunk: Buffer) => {
      if (aborted) return; // ignore late chunks after a cap breach
      size += chunk.length;
      if (size > maxFileSizeBytes) {
        aborted = true;
        // pause() halts the jszip/pako worker via upstream backpressure; the
        // `aborted` flag drops any already-in-flight chunk. We deliberately do
        // NOT use destroy(): jszip's NodejsStreamOutputAdapter doesn't override
        // _destroy, so destroy() only push(null)s — it does NOT stop the worker
        // (it keeps inflating) and floods swallowed "push after EOF" errors.
        // pause() is also the only one of the two declared on jszip's
        // NodeJS.ReadableStream type, so destroy() fails the typecheck.
        stream.pause();
        reject(
          new Error(
            `bundle file ${path} is over ${maxFileSizeBytes} bytes (max ${maxFileSizeBytes})`
          )
        );
        return;
      }
      if (size > remainingTotalBytes) {
        aborted = true;
        stream.pause();
        reject(
          new Error(
            `bundle decompresses to more than ${maxTotalBytes} bytes (zip bomb?)`
          )
        );
        return;
      }
      chunks.push(chunk);
    });
    stream.on('error', (err: Error) => {
      if (aborted) return;
      aborted = true;
      reject(err);
    });
    stream.on('end', () => {
      if (aborted) return;
      resolve(Buffer.concat(chunks, size));
    });
  });
}

/**
 * Extract every file in the ZIP as { path, sha256, sizeBytes }. Validates
 * file-count, per-file size, the cumulative decompressed-byte ceiling, and
 * that block.manifest.json is present and parseable. Returns the parsed
 * manifest alongside the file map so the caller doesn't re-scan the ZIP.
 *
 * Each entry is decompressed via a streaming reader (readZipEntryCapped)
 * that aborts the instant the per-file OR running-aggregate cap is exceeded,
 * so a zip bomb can never be fully materialised in memory.
 *
 * Caps are injectable (opts) so unit tests can exercise the aggregate-abort
 * path with tiny ZIPs; every existing call site passes just the buffer and
 * inherits the schema-constant defaults.
 *
 * Throws on: too many files, file too large, cumulative decompressed size
 * over cap, missing manifest, manifest not valid JSON.
 */
export async function extractBundleMetadata(
  bundleBuffer: Buffer,
  opts: { maxFiles?: number; maxFileSizeBytes?: number; maxTotalBytes?: number } = {}
): Promise<{
  files: FileMeta[];
  manifest: unknown;
}> {
  const maxFiles = opts.maxFiles ?? MAX_FILES_IN_BUNDLE;
  const maxFileSizeBytes = opts.maxFileSizeBytes ?? MAX_FILE_SIZE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? MAX_TOTAL_DECOMPRESSED_BYTES;

  const zip = await JSZip.loadAsync(bundleBuffer);
  const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
  if (entries.length === 0) {
    throw new Error('bundle is empty (no files)');
  }
  if (entries.length > maxFiles) {
    throw new Error(`bundle contains ${entries.length} files (max ${maxFiles})`);
  }

  const files: FileMeta[] = [];
  let manifestRaw: string | null = null;
  let totalBytes = 0;

  for (const [rawPath, entry] of entries) {
    // No filesystem-traversal guard needed: jszip normalises `..`
    // segments out of entry paths, and the approve flow uploads files
    // via the Forgejo content API (repo-relative paths, no fs writes).
    const contents = await readZipEntryCapped(entry, {
      maxFileSizeBytes,
      remainingTotalBytes: maxTotalBytes - totalBytes,
      maxTotalBytes,
      path: rawPath,
    });
    totalBytes += contents.length;
    files.push({
      path: rawPath,
      sha256: createHash('sha256').update(contents).digest('hex'),
      sizeBytes: contents.length,
    });
    if (rawPath === MANIFEST_PATH) {
      manifestRaw = contents.toString('utf8');
    }
  }

  if (manifestRaw === null) {
    throw new Error(`bundle is missing required file: ${MANIFEST_PATH}`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (err) {
    throw new Error(`${MANIFEST_PATH} is not valid JSON: ${(err as Error).message}`);
  }

  // Deterministic ordering so the file list is stable across submissions.
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, manifest };
}

// ---------------------------------------------------------------------------
// F-E E5 — screenshot capture (convention-based bundle discovery).
// ---------------------------------------------------------------------------

/** A validated, magic-byte-checked screenshot extracted from a bundle. */
export type ExtractedScreenshot = {
  /** 0-based gallery position (display order = ascending bundle-path order). */
  index: number;
  /** Normalised extension (jpg, not jpeg) used for the stored object key + content-type. */
  ext: ScreenshotExtension;
  /** MIME type derived from the validated magic bytes (NOT the filename). */
  contentType: string;
  /** Raw decompressed image bytes. */
  content: Buffer;
};

const SCREENSHOT_CONTENT_TYPE: Record<ScreenshotExtension, string> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

/**
 * A screenshot filename under `screenshots/` may ONLY be a flat, safe name:
 * no nested dirs, no path-traversal, no leading dot, just `[A-Za-z0-9._-]`
 * before the extension. This rejects `screenshots/../evil`, `screenshots/a/b.png`
 * (sub-dir), `screenshots/.hidden.png`, and odd/encoded names — the entry must
 * be exactly `screenshots/<name>.<ext>` at the top of the screenshots dir.
 */
const SCREENSHOT_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Validate that `buf` actually IS an image of the claimed extension by its
 * magic bytes — the file EXTENSION is never trusted (a `.png` that is really a
 * script/HTML/SVG payload must be REJECTED). This is the core anti-abuse check
 * for publisher-supplied images: the public gallery only ever serves bytes that
 * passed this gate, with the content-type derived from the bytes, not the name.
 *
 *   - PNG  : 89 50 4E 47 0D 0A 1A 0A   (8-byte signature)
 *   - JPEG : FF D8 FF                   (SOI marker)
 *   - WebP : "RIFF" .... "WEBP"         (RIFF container, WEBP fourCC at byte 8)
 *
 * Returns the normalised extension the bytes match, or null if the bytes don't
 * match the claimed extension's signature (claimed-vs-actual must agree — a real
 * JPEG uploaded as `.png` is rejected too, so the content-type we serve is
 * always correct + consistent with the stored key).
 */
export function detectImageType(buf: Buffer, claimedExt: ScreenshotExtension): ScreenshotExtension | null {
  const isPng =
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a;
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const isWebp =
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP';

  // The bytes must match the claimed extension's family. `.jpg`/`.jpeg` are the
  // same format → both require the JPEG signature and normalise to `jpg`.
  if (claimedExt === 'png') return isPng ? 'png' : null;
  if (claimedExt === 'webp') return isWebp ? 'webp' : null;
  if (claimedExt === 'jpg' || claimedExt === 'jpeg') return isJpeg ? 'jpg' : null;
  return null;
}

/** Parse + lower-case the extension of a `screenshots/<name>.<ext>` entry. */
function screenshotExt(filename: string): ScreenshotExtension | null {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return null; // no extension, or a dotfile with no name
  const ext = filename.slice(dot + 1).toLowerCase();
  return (SCREENSHOT_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as ScreenshotExtension)
    : null;
}

/**
 * F-E E5 — auto-discover + validate publisher screenshots from a bundle ZIP.
 *
 * Convention-based (decision #2): no SDK manifest field. Any entry directly
 * under the reserved `screenshots/` dir whose name parses to an accepted image
 * extension is a candidate. Each candidate is validated:
 *   - NAME      — flat safe name only (SCREENSHOT_NAME_REGEX); no sub-dirs, no
 *                 `..`, no leading dot, no odd/encoded names. Anything that
 *                 isn't `screenshots/<safe-name>.<ext>` is REJECTED.
 *   - SIZE      — per-screenshot cap (MAX_SCREENSHOT_SIZE_BYTES), tighter than
 *                 the generic per-file cap. Read via the streaming capped reader
 *                 so an oversized entry aborts before fully materialising.
 *   - MAGIC     — the BYTES must match the claimed extension's image signature
 *                 (detectImageType); a `.png` that isn't a real PNG is REJECTED.
 *   - COUNT     — at most MAX_SCREENSHOTS; the (N+1)th is REJECTED (NOT silently
 *                 truncated) so a publisher can't bury non-image payloads past a
 *                 truncation boundary.
 *
 * No `screenshots/` dir (or only the bare dir entry) → returns `[]` (fine).
 *
 * Pure + DB/MinIO-free so it's unit-testable; called at submit (fail-fast
 * validation) AND at approve (materialise to MinIO + the app_blocks row).
 * Index = ascending bundle-path order, so the gallery order is deterministic
 * and stable across re-submits.
 *
 * Throws (with a human-readable message the submit route surfaces inline) on
 * any cap/validation breach — the WHOLE submission is rejected, consistent with
 * the existing bundle-validation failure semantics (no partial capture).
 */
export async function extractScreenshots(
  bundleBuffer: Buffer,
  opts: { maxScreenshots?: number; maxScreenshotSizeBytes?: number } = {}
): Promise<ExtractedScreenshot[]> {
  const maxScreenshots = opts.maxScreenshots ?? MAX_SCREENSHOTS;
  const maxScreenshotSizeBytes = opts.maxScreenshotSizeBytes ?? MAX_SCREENSHOT_SIZE_BYTES;

  const zip = await JSZip.loadAsync(bundleBuffer);

  // Candidate entries: non-dir files whose path begins with `screenshots/`.
  // Sort by path so the gallery index is deterministic regardless of ZIP order.
  const candidates = Object.entries(zip.files)
    .filter(([rawPath, entry]) => !entry.dir && rawPath.startsWith(SCREENSHOT_DIR))
    .sort(([a], [b]) => a.localeCompare(b));

  // COUNT cap — reject (don't truncate) so nothing is silently dropped.
  if (candidates.length > maxScreenshots) {
    throw new Error(
      `bundle has ${candidates.length} files under ${SCREENSHOT_DIR} (max ${maxScreenshots} screenshots)`
    );
  }

  const out: ExtractedScreenshot[] = [];
  for (const [rawPath, entry] of candidates) {
    const filename = rawPath.slice(SCREENSHOT_DIR.length);
    // NAME: must be a flat safe filename — no nested path, no traversal, no
    // leading dot. (jszip already normalises `..`, but reject any residual
    // slash / odd name explicitly rather than rely on that.)
    if (filename.includes('/') || filename.includes('\\') || !SCREENSHOT_NAME_REGEX.test(filename)) {
      throw new Error(
        `invalid screenshot filename "${rawPath}" — only flat names like ${SCREENSHOT_DIR}shot-1.png are allowed (no sub-directories, no "..", no leading dot)`
      );
    }
    const claimedExt = screenshotExt(filename);
    if (!claimedExt) {
      throw new Error(
        `screenshot "${rawPath}" must be one of: ${SCREENSHOT_EXTENSIONS.join(', ')}`
      );
    }
    // SIZE: stream with the tighter screenshot cap; aborts mid-stream on breach.
    let content: Buffer;
    try {
      content = await readZipEntryCapped(entry, {
        maxFileSizeBytes: maxScreenshotSizeBytes,
        // Screenshots also count against the generic aggregate budget, but the
        // bundle already passed extractBundleMetadata's aggregate cap; here we
        // only need the per-screenshot bound, so the "remaining" budget is the
        // per-file cap itself (any single screenshot over its own cap aborts).
        remainingTotalBytes: maxScreenshotSizeBytes,
        maxTotalBytes: maxScreenshotSizeBytes,
        path: rawPath,
      });
    } catch (err) {
      // Re-wrap the generic over-cap message into a screenshot-specific one.
      throw new Error(
        `screenshot "${rawPath}" is over ${maxScreenshotSizeBytes} bytes (max ${maxScreenshotSizeBytes} per screenshot)`
      );
    }
    // MAGIC: the bytes must actually be an image of the claimed type.
    const detected = detectImageType(content, claimedExt);
    if (!detected) {
      throw new Error(
        `screenshot "${rawPath}" is not a valid ${claimedExt.toUpperCase()} image (its bytes do not match the expected image signature)`
      );
    }
    out.push({
      index: out.length,
      ext: detected,
      contentType: SCREENSHOT_CONTENT_TYPE[detected],
      content,
    });
  }
  return out;
}

/**
 * F-E E5 — upload validated screenshots to the bundle MinIO under a path scoped
 * by appBlockId (the row that will display them): `screenshots/<appBlockId>/<index>.<ext>`.
 * Content-type is the magic-byte-derived value (never the filename's). Returns
 * the stored-screenshot records persisted to `app_blocks.screenshots`.
 *
 * Called at APPROVE (when appBlockId is known + the bundle has passed review).
 * Idempotent on the key: re-approving the same app overwrites the same objects.
 */
export type StoredScreenshot = {
  key: string;
  index: number;
  ext: ScreenshotExtension;
  contentType: string;
  /**
   * F-E E5 autogen — true when this record was machine-captured (verify-runner
   * screenshot of the running block) rather than publisher-supplied. The public
   * serving route ignores this field; it exists so the deploy/backfill autogen
   * path can detect "this app only has an autogenerated shot" and a later
   * publisher upload (re-approve) is preferred (a dev re-approve overwrites the
   * whole `screenshots` array with the bundle's records, dropping this flag).
   */
  autogenerated?: boolean;
};

export async function storeScreenshots(
  appBlockId: string,
  screenshots: ExtractedScreenshot[]
): Promise<StoredScreenshot[]> {
  if (screenshots.length === 0) return [];
  const { getBundleBucket, getBundleS3Client } = await import('~/utils/bundle-s3');
  const client = getBundleS3Client();
  const bucket = getBundleBucket();
  const stored: StoredScreenshot[] = [];
  for (const s of screenshots) {
    const key = `screenshots/${appBlockId}/${s.index}.${s.ext}`;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: s.content,
        ContentType: s.contentType,
      })
    );
    stored.push({ key, index: s.index, ext: s.ext, contentType: s.contentType });
  }
  return stored;
}

/**
 * Diff two file lists (by path + sha256). Returns added/removed/changed
 * paths plus the new file list embedded (so the next submission can diff
 * against it without re-fetching the bundle).
 */
export function computeFileDiff(
  currentFiles: FileMeta[],
  previousFiles: FileMeta[] | null
): FileSummary {
  if (previousFiles === null) {
    return {
      files: currentFiles,
      added: currentFiles.map((f) => f.path),
      removed: [],
      changed: [],
    };
  }
  const prevByPath = new Map(previousFiles.map((f) => [f.path, f]));
  const currByPath = new Map(currentFiles.map((f) => [f.path, f]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [path, file] of currByPath) {
    const prev = prevByPath.get(path);
    if (!prev) {
      added.push(path);
    } else if (prev.sha256 !== file.sha256) {
      changed.push(path);
    }
  }
  for (const path of prevByPath.keys()) {
    if (!currByPath.has(path)) removed.push(path);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return { files: currentFiles, added, removed, changed };
}

// ---------------------------------------------------------------------------
// Per-file LINE-level diff for the moderator review UI.
//
// The file-level summary (computeFileDiff) tells a mod WHICH files changed; this
// computes the unified line diff of WHAT changed inside each changed/added text
// file between the pending bundle and the previous approved version, so the
// reviewer can read the actual code change in the modal instead of clicking out
// to Forgejo for every file.
//
// HARD BOUNDS (the correctness concern — never load unbounded content into the
// response or memory):
//   - TEXT FILES ONLY: a binary file (by extension or a NUL byte in the first
//     few KiB of either side) is reported as `skipped: 'binary'`, never diffed.
//   - PER-FILE BYTE CAP: a file whose current OR previous side exceeds
//     MAX_DIFF_FILE_BYTES is reported `skipped: 'too-large'` (no diff computed).
//   - PER-FILE LINE CAP: a unified diff that produces more than MAX_DIFF_LINES
//     total hunk lines is elided (`skipped: 'diff-too-large'`) and its lines
//     dropped from the payload.
//   - TOTAL FILE CAP: at most MAX_DIFF_FILES files are diffed; the rest are
//     reported `skipped: 'file-cap'` so the UI can point them at Forgejo.
// Every elision is explicitly marked so the UI shows "diff too large / binary —
// view in Forgejo" rather than silently omitting a change.
// ---------------------------------------------------------------------------

/** Why a changed/added file's line diff was NOT inlined (UI shows the Forgejo
 *  fallback for these). `null` ⇒ the diff is present in `hunks`. */
export type DiffSkipReason = 'binary' | 'too-large' | 'diff-too-large' | 'file-cap';

/** One contiguous unified-diff hunk for a file (mirrors `diff`'s Hunk shape,
 *  trimmed to what the UI renders). `lines` are prefixed `+`/`-`/` `. */
export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export type FileLineDiff = {
  path: string;
  /** 'added' (no previous content) or 'changed' (content differs). Removed +
   *  unchanged files are not emitted — the file-level summary already lists
   *  removals, and unchanged files have no diff. */
  changeKind: 'added' | 'changed';
  /** Present iff skipReason is null. Empty array ⇒ no textual change (e.g. a
   *  trailing-newline-only delta that produced no hunks). */
  hunks: DiffHunk[];
  /** null ⇒ diffed; otherwise the file was elided for this reason. */
  skipReason: DiffSkipReason | null;
  added: number;
  removed: number;
};

export type BundleLineDiff = {
  files: FileLineDiff[];
  /** Files the per-file cap elided (changeKind known, no hunks). */
  truncated: boolean;
};

// Bounds. Tuned for a code review UI, not a data export — a single oversized
// file or a generated lockfile diff must never balloon the tRPC response.
const DEFAULT_BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'gif',
  'bmp',
  'ico',
  'avif',
  'tiff',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'zip',
  'gz',
  'tar',
  'tgz',
  'br',
  '7z',
  'rar',
  'pdf',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'webm',
  'wav',
  'ogg',
  'flac',
  'wasm',
  'so',
  'dll',
  'dylib',
  'bin',
  'exe',
  'class',
  'node',
  'pyc',
  'jar',
  'icns',
  'psd',
  'sketch',
]);
const MAX_DIFF_FILE_BYTES = 256 * 1024; // 256 KiB per side
const MAX_DIFF_LINES = 2000; // total +/-/context lines across all hunks per file
const MAX_DIFF_FILES = 300; // most files we'll diff in one request
const NUL_SNIFF_BYTES = 8192; // bytes inspected for a NUL byte (binary sniff)

/** Extension-based binary check (lower-cased final extension). */
function isBinaryExtension(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return DEFAULT_BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** NUL-byte sniff over the first NUL_SNIFF_BYTES — a NUL byte never appears in
 *  UTF-8/ASCII text, so it's a reliable binary signal for files an extension
 *  check misses (e.g. an extension-less compiled artifact). */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, NUL_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Pure, IO-free per-file unified line diff between the current bundle's files
 * and the previous approved version's files. Operates on already-extracted
 * `{ path, content }` buffers so it's unit-testable without MinIO/Forgejo.
 *
 * Emits ONE entry per added/changed text file (in sorted path order), each
 * either carrying its unified hunks or a `skipReason` marking why it was elided.
 * Removed + unchanged files are omitted (the file summary covers removals;
 * unchanged files have no diff).
 *
 * `previousFiles === null` ⇒ first version: every file is `changeKind:'added'`
 * and diffed against the empty string (whole-file add), still subject to the
 * same binary/size/line caps.
 *
 * Caps are injectable for tests; production passes the module defaults.
 */
export function computeBundleLineDiff(
  currentFiles: Array<{ path: string; content: Buffer }>,
  previousFiles: Array<{ path: string; content: Buffer }> | null,
  opts: {
    maxFileBytes?: number;
    maxDiffLines?: number;
    maxFiles?: number;
  } = {}
): BundleLineDiff {
  const maxFileBytes = opts.maxFileBytes ?? MAX_DIFF_FILE_BYTES;
  const maxDiffLines = opts.maxDiffLines ?? MAX_DIFF_LINES;
  const maxFiles = opts.maxFiles ?? MAX_DIFF_FILES;

  const prevByPath = new Map((previousFiles ?? []).map((f) => [f.path, f.content]));

  // Determine which files to diff: added (not in prev) or changed (bytes
  // differ). Sorted for a deterministic, scannable UI ordering.
  const candidates: Array<{ path: string; changeKind: 'added' | 'changed' }> = [];
  for (const f of currentFiles) {
    const prev = prevByPath.get(f.path);
    if (prev === undefined) {
      candidates.push({ path: f.path, changeKind: 'added' });
    } else if (!prev.equals(f.content)) {
      candidates.push({ path: f.path, changeKind: 'changed' });
    }
  }
  candidates.sort((a, b) => a.path.localeCompare(b.path));

  const currByPath = new Map(currentFiles.map((f) => [f.path, f.content]));
  const files: FileLineDiff[] = [];
  let truncated = false;

  for (let i = 0; i < candidates.length; i++) {
    const { path, changeKind } = candidates[i];
    const curBuf = currByPath.get(path) as Buffer;
    const prevBuf = prevByPath.get(path) ?? null;

    // TOTAL FILE CAP — beyond maxFiles, emit a marker (no diff) so the UI can
    // say "view in Forgejo" rather than silently dropping the file.
    if (i >= maxFiles) {
      truncated = true;
      files.push({ path, changeKind, hunks: [], skipReason: 'file-cap', added: 0, removed: 0 });
      continue;
    }

    // BINARY — extension OR NUL-byte sniff on either side.
    if (
      isBinaryExtension(path) ||
      looksBinary(curBuf) ||
      (prevBuf !== null && looksBinary(prevBuf))
    ) {
      files.push({ path, changeKind, hunks: [], skipReason: 'binary', added: 0, removed: 0 });
      continue;
    }

    // PER-FILE BYTE CAP — either side over the cap is elided undiffed.
    if (curBuf.length > maxFileBytes || (prevBuf !== null && prevBuf.length > maxFileBytes)) {
      files.push({ path, changeKind, hunks: [], skipReason: 'too-large', added: 0, removed: 0 });
      continue;
    }

    const oldStr = prevBuf !== null ? prevBuf.toString('utf8') : '';
    const newStr = curBuf.toString('utf8');
    const patch = structuredPatch(path, path, oldStr, newStr, '', '', { context: 3 });

    // PER-FILE LINE CAP — count total emitted hunk lines; elide if over cap.
    let totalLines = 0;
    let added = 0;
    let removed = 0;
    for (const h of patch.hunks) {
      totalLines += h.lines.length;
      for (const line of h.lines) {
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }
    }
    if (totalLines > maxDiffLines) {
      files.push({
        path,
        changeKind,
        hunks: [],
        skipReason: 'diff-too-large',
        added,
        removed,
      });
      continue;
    }

    files.push({
      path,
      changeKind,
      hunks: patch.hunks.map((h) => ({
        oldStart: h.oldStart,
        oldLines: h.oldLines,
        newStart: h.newStart,
        newLines: h.newLines,
        lines: h.lines,
      })),
      skipReason: null,
      added,
      removed,
    });
  }

  return { files, truncated };
}

/**
 * Field-level diff between two manifests. v0 only inspects top-level
 * fields (sufficient for the mod-review UI signal). Embedded objects
 * (iframe, targets, scopes) compare by stableHash so any deep change
 * surfaces.
 */
export function computeManifestDiff(
  currentManifest: Record<string, unknown>,
  previousManifest: Record<string, unknown> | null
): ManifestDiffSummary {
  if (previousManifest === null) {
    return {
      kind: 'first-version',
      fields: Object.keys(currentManifest).sort(),
    };
  }
  const allKeys = new Set([...Object.keys(currentManifest), ...Object.keys(previousManifest)]);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const key of allKeys) {
    const hasCurr = key in currentManifest;
    const hasPrev = key in previousManifest;
    if (hasCurr && !hasPrev) {
      added.push(key);
    } else if (!hasCurr && hasPrev) {
      removed.push(key);
    } else if (hasCurr && hasPrev) {
      const a = currentManifest[key];
      const b = previousManifest[key];
      if (stableHash(a) !== stableHash(b)) {
        changed.push({
          field: key,
          from: summariseValue(b),
          to: summariseValue(a),
        });
      }
    }
  }
  added.sort();
  removed.sort();
  changed.sort((a, b) => a.field.localeCompare(b.field));
  return { kind: 'update', added, removed, changed };
}

/**
 * Upload a bundle buffer to MinIO. Idempotent on the SHA — if the same
 * bytes have been uploaded before (e.g. a re-submit) the second put is a
 * no-op overwrite of identical content.
 */
async function storeBundle(bundleBuffer: Buffer, sha256: string): Promise<string> {
  const { bundleKey, getBundleBucket, getBundleS3Client } = await import('~/utils/bundle-s3');
  const key = bundleKey(sha256);
  const client = getBundleS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: getBundleBucket(),
      Key: key,
      Body: bundleBuffer,
      ContentType: 'application/zip',
      Metadata: { sha256 },
    })
  );
  return key;
}

/**
 * Fire-and-forget Discord notify on a new pending publish request.
 * Posts to DISCORD_WEBHOOK_MOD_ALERTS if set. Never throws — Discord
 * outages must not block submissions. Caller doesn't await.
 */
async function notifyModsOfNewRequest(opts: {
  slug: string;
  version: string;
  publishRequestId: string;
  submittedByUsername: string | null;
  submittedByUserId: number;
  manifestDiffKind: 'first-version' | 'update';
  fileChangeCounts: { added: number; changed: number; removed: number };
}): Promise<void> {
  try {
    const { env } = await import('~/env/server');
    if (!env.DISCORD_WEBHOOK_MOD_ALERTS) return;
    const baseUrl = (process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '');
    const reviewUrl = baseUrl ? `${baseUrl}/apps/review` : '/apps/review';
    const submitter = opts.submittedByUsername ?? `user #${opts.submittedByUserId}`;
    const changeSummary =
      opts.manifestDiffKind === 'first-version'
        ? 'first version'
        : `+${opts.fileChangeCounts.added} ~${opts.fileChangeCounts.changed} −${opts.fileChangeCounts.removed} files`;

    const payload = {
      embeds: [
        {
          title: `New publish request: ${opts.slug} v${opts.version}`,
          url: reviewUrl,
          color: 0x1971c2,
          fields: [
            { name: 'Submitted by', value: submitter, inline: true },
            { name: 'Changes', value: changeSummary, inline: true },
            { name: 'Request ID', value: `\`${opts.publishRequestId}\`` },
          ],
          footer: { text: 'Apps publish-request queue' },
          timestamp: new Date().toISOString(),
        },
      ],
    };
    await fetch(env.DISCORD_WEBHOOK_MOD_ALERTS, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {
      /* fire and forget */
    });
  } catch {
    /* never let Discord break submission */
  }
}

/**
 * Look up the previous APPROVED publish request for this slug, if any.
 * Returns the stored file map + manifest from that row so we can diff
 * against it without re-fetching the bundle from MinIO.
 *
 * Returns null on first-version submissions.
 */
async function getPreviousApprovedState(
  slug: string,
  excludePublishRequestId?: string
): Promise<{ files: FileMeta[]; manifest: Record<string, unknown> } | null> {
  const { dbRead } = await import('~/server/db/client');
  const prior = await dbRead.appBlockPublishRequest.findFirst({
    where: {
      slug,
      status: 'approved',
      ...(excludePublishRequestId ? { NOT: { id: excludePublishRequestId } } : {}),
    },
    orderBy: { reviewedAt: 'desc' },
    select: { manifest: true, fileSummary: true },
  });
  if (!prior) return null;
  const fileSummary = prior.fileSummary as unknown as FileSummary;
  return {
    files: fileSummary.files ?? [],
    manifest: prior.manifest as Record<string, unknown>,
  };
}

/**
 * Main entry. Orchestrates the full submission pipeline. Returns the
 * inserted row's id + the diff so the UI can render a preview without a
 * second round-trip.
 */
export async function submitVersion(params: SubmitVersionParams): Promise<SubmitVersionResult> {
  const [{ dbRead, dbWrite }, { newUlid, newAppListingId }, { SEMVER_REGEX, SLUG_REGEX }] =
    await Promise.all([
      import('~/server/db/client'),
      import('~/server/utils/app-block-ids'),
      import('~/server/schema/blocks/publish-request.schema'),
    ]);
  const { bundleBuffer, submittedByUserId } = params;

  if (bundleBuffer.length > MAX_BUNDLE_SIZE_BYTES) {
    throw new Error(`bundle is ${bundleBuffer.length} bytes (max ${MAX_BUNDLE_SIZE_BYTES})`);
  }
  if (bundleBuffer.length === 0) {
    throw new Error('bundle is empty');
  }

  const bundleSha256 = createHash('sha256').update(bundleBuffer).digest('hex');

  // Extract + validate the bundle FIRST so we have the manifest's
  // blockId / version / name to drive the rest of the pipeline. The
  // manifest is the source of truth — there are no separate form
  // fields the dev could mis-type.
  const { files, manifest: rawManifest } = await extractBundleMetadata(bundleBuffer);
  if (!rawManifest || typeof rawManifest !== 'object') {
    throw new Error(`${MANIFEST_PATH} must contain a JSON object`);
  }
  const manifest = rawManifest as Record<string, unknown>;

  if (typeof manifest.blockId !== 'string') {
    throw new Error('manifest.blockId must be a string');
  }
  if (
    manifest.blockId.length < 3 ||
    manifest.blockId.length > 40 ||
    !SLUG_REGEX.test(manifest.blockId)
  ) {
    throw new Error(
      `manifest.blockId "${manifest.blockId}" must be 3-40 chars, lowercase a-z/0-9/hyphens, start with a letter, end with a letter or digit`
    );
  }
  if (typeof manifest.version !== 'string' || !SEMVER_REGEX.test(manifest.version)) {
    throw new Error(`manifest.version "${manifest.version ?? ''}" must be semver (e.g. 0.1.0)`);
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error('manifest.name must be a non-empty string');
  }

  const slug = manifest.blockId;
  const version = manifest.version;

  // Sensitive-scope justification gate — enforced AT SUBMIT (fail-fast, before
  // the MinIO upload + review-repo push). The primary submit path (CLI `app
  // submit` + the web session-submit route) deliberately defers the deep
  // BlockManifestValidator to APPROVE — and approve exempts THIS rule
  // (`enforceSensitiveScopeJustification:false`, to grandfather legacy pending
  // requests) — so without this call the sensitive-scope enforcement shipped in
  // #3451 never fires for a CLI/web-session submit (a live dogfood submitted an
  // `ai:write:budgeted` app with no scopeJustifications and it was accepted).
  // The check needs only the manifest's `scopes` + `scopeJustifications`, both
  // already present in the extracted manifest — no AppContext needed — so we run
  // the targeted rule here via the SAME single-sourced helper the validator
  // uses (DRY; identical message). `assertSensitiveScopesJustified` throws a
  // plain Error, which the CLI route surfaces as a 400 and the web session
  // route surfaces likewise. Deep validation stays deferred to approve.
  assertSensitiveScopesJustified(manifest);

  // F-E E5 — validate publisher screenshots NOW (fail-fast) so a bundle with a
  // too-many / oversized / fake-image / odd-named screenshot is rejected inline
  // in the submit modal rather than silently carried to the mod queue. The
  // bytes themselves are re-extracted + uploaded at APPROVE (when appBlockId is
  // known); here we only assert they pass every cap/magic-byte/name gate.
  await extractScreenshots(bundleBuffer);

  // iframe.src is PLATFORM-OWNED, not developer-authored. The only valid value
  // is the canonical per-app subdomain root (`https://<slug>.<APPS_DOMAIN>/`),
  // so we DERIVE + stamp it here instead of making the developer hand-type a
  // subdomain that doesn't exist until their app is approved (and rejecting them
  // — after a multi-MiB upload — if they get it wrong). Any dev-supplied or
  // missing iframe.src is overwritten. Stamping now means the stored
  // publish-request manifest, the manifest diff, and everything the mod reviews
  // already carry the canonical value; approve re-stamps defensively and the
  // deep BlockManifestValidator there still validates it against
  // OauthClient.allowedOrigins. Mirrors how trustTier is server-owned.
  const { env } = await import('~/env/server');
  stampCanonicalIframeSrc(manifest, slug, env.APPS_DOMAIN);

  // Block double-submit on the same slug — only one pending request per
  // slug at a time. The /apps/submit UI calls getMyPendingForSlug on
  // preview to surface a "withdraw and resubmit" affordance before the
  // user gets here; this server-side check is the fallback for races and
  // direct-API callers. The partial unique index on (slug) WHERE
  // status='pending' (audit C-4) catches the same-instant race.
  //
  // Same-user collision wording assumes the caller can self-withdraw;
  // other-user collision wording avoids leaking the request id (which is
  // useless to a non-owner — only the original submitter or a mod can
  // act on it).
  const conflicting = await dbRead.appBlockPublishRequest.findFirst({
    where: { slug, status: 'pending' },
    select: { id: true, submittedByUserId: true },
  });
  if (conflicting) {
    if (conflicting.submittedByUserId === submittedByUserId) {
      throw new Error(
        `you already have a pending submission for slug ${slug} (${conflicting.id}); withdraw it first with \`civitai app withdraw ${conflicting.id}\` before resubmitting`
      );
    }
    throw new Error(
      `slug ${slug} already has a pending submission from another user; wait for it to be reviewed before submitting a different bundle`
    );
  }

  // For subsequent versions, link to the existing app row.
  const existingApp = await dbRead.appBlock.findFirst({
    where: { blockId: slug },
    select: { id: true, appId: true },
  });

  // (submit-draft pre-check) W13 draft-at-submit — a FIRST-version submit now also
  // mints the on-site store `AppListing` as a pre-approval DRAFT (kind='onsite',
  // status='draft', appBlockId=NULL) so the author can set listing media
  // (icon/cover/screenshots) WHILE the app is still pending review (they carry
  // forward on approve). Mirrors the proven off-site `submitExternalListing` shape (a
  // draft listing minted at submit, deleted on reject/withdraw). Only a first-version
  // submit (`existingApp == null`) is meaningful: a subsequent version already has an
  // approved listing whose media edits go through the shadow-revision path.
  //
  // Fail fast (BEFORE the MinIO upload + review-repo push) if the store slug is
  // already taken in `app_listings` by a NON-reusable listing — the draft reserves
  // `AppListing.slug @unique`, and the friendly error mirrors `submitExternalListing`'s
  // slug pre-check. An existing on-site pre-approval DRAFT for this slug (no backing
  // AppBlock) is a REUSABLE orphan (a prior submit whose reject/withdraw cleanup didn't
  // run) — reuse it idempotently rather than error, so a re-submit never duplicates.
  //
  // 🔴 Reuse is OWNER-SCOPED (`userId === submittedByUserId`). An orphan draft keeps its
  // original owner, and the approve transition carries that `userId` FORWARD untouched —
  // so reusing ANOTHER user's orphan would hand them ownership of THIS submitter's
  // approved store listing (the listing-media procs gate on `AppListing.userId`, so they
  // would control its media). A same-slug orphan owned by someone else is therefore
  // treated as TAKEN, exactly like any other foreign listing on the slug.
  let createDraftListing = false;
  if (existingApp == null) {
    const existingSlugListing = await dbRead.appListing.findFirst({
      where: { slug },
      select: { id: true, kind: true, status: true, appBlockId: true, userId: true },
    });
    if (!existingSlugListing) {
      createDraftListing = true;
    } else if (
      !(
        existingSlugListing.kind === 'onsite' &&
        existingSlugListing.status === 'draft' &&
        existingSlugListing.appBlockId == null &&
        existingSlugListing.userId === submittedByUserId
      )
    ) {
      throw new Error(
        `store slug "${slug}" is already taken by another store listing; choose a different blockId`
      );
    }
    // else: a reusable on-site pre-approval draft owned by THIS submitter already exists
    // for this slug → reuse it (idempotent re-submit), so createDraftListing stays false.
  }

  // Deep manifest validation (contentRating / scopes / iframe.sandbox /
  // targets / scope subset / iframe.src origin) happens at the
  // BlockManifestValidator step in the approve flow, when the
  // OauthClient with allowedOrigins is known. The basic blockId /
  // version / name shape checks above are the only submit-time gate.

  // Diff against the previous approved version (if any).
  const previous = await getPreviousApprovedState(slug);
  const fileSummary = computeFileDiff(files, previous?.files ?? null);
  const manifestDiffSummary = computeManifestDiff(manifest, previous?.manifest ?? null);

  // Upload bundle to MinIO. PutObject is idempotent on the SHA, so a
  // retry after an upstream error reuses the same key safely.
  const key = await storeBundle(bundleBuffer, bundleSha256);

  // Push the bundle's files into the per-slug review repo on Forgejo so
  // mods can see the actual code (not just the manifest diff) at
  // /apps/review. One repo per slug under civitai-apps-review/<slug>;
  // overwritten on each submit. Separate org from civitai-apps so the
  // build webhook + Tekton don't accidentally fire on these commits.
  //
  // Re-decoding the ZIP buffer is cheap (in-memory; ~50ms for a 50 MiB
  // bundle on a modern node). The alternative — threading the per-file
  // contents through extractBundleMetadata's return shape — would bloat
  // the diff-only call sites that don't need bytes.
  try {
    const { commitFiles, ensureReviewRepo } = await import('./forgejo.service');
    const reviewZip = await JSZip.loadAsync(bundleBuffer);
    const reviewFiles: Array<{ path: string; content: Buffer }> = [];
    // Defense-in-depth: this loop materialises every entry buffer into one
    // in-memory array, so re-apply the same per-file + running-aggregate caps
    // (the bundle was already validated by extractBundleMetadata above; this
    // closes the gap if that's ever bypassed and bounds the resident bytes).
    let reviewTotalBytes = 0;
    for (const [path, entry] of Object.entries(reviewZip.files)) {
      if (entry.dir) continue;
      const content = await readZipEntryCapped(entry, {
        maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
        remainingTotalBytes: MAX_TOTAL_DECOMPRESSED_BYTES - reviewTotalBytes,
        maxTotalBytes: MAX_TOTAL_DECOMPRESSED_BYTES,
        path,
      });
      reviewTotalBytes += content.length;
      reviewFiles.push({ path, content });
    }
    await ensureReviewRepo(slug);
    await commitFiles({
      org: 'civitai-apps-review',
      slug,
      files: reviewFiles,
      message: `Publish request ${version} bundle (sha ${bundleSha256.slice(0, 12)})`,
      replaceAllFiles: true,
    });
  } catch (err) {
    throw new Error(`could not push bundle to review repo: ${(err as Error).message}`);
  }

  const publishRequestId = `pubreq_${newUlid()}`;
  try {
    await dbWrite.appBlockPublishRequest.create({
      data: {
        id: publishRequestId,
        appBlockId: existingApp?.id ?? null,
        slug,
        submittedByUserId,
        version,
        manifest: manifest as object,
        bundleKey: key,
        bundleSha256,
        bundleSizeBytes: BigInt(bundleBuffer.length),
        fileSummary: fileSummary as object,
        manifestDiffSummary: manifestDiffSummary as object,
        status: 'pending',
      },
    });
  } catch (err) {
    // C-4 fix: the partial unique index app_block_publish_requests_one_
    // pending_per_slug catches the race window between our findFirst above
    // and this INSERT — two parallel submitVersion calls for the same slug
    // both pass the app-layer check and arrive here. Convert the raw
    // Postgres unique-violation into the same human-readable message the
    // app-layer check would have surfaced.
    const code = (err as { code?: unknown })?.code;
    if (code === 'P2002') {
      throw new Error(
        `slug ${slug} already has a pending publish request (race window); withdraw the other or retry`
      );
    }
    throw err;
  }

  // (submit-draft) W13 draft-at-submit — mint the pre-approval on-site draft
  // `AppListing` now that the pending request exists. Ordered AFTER the request create
  // so there is never a draft orphaned without a request: a request without a draft
  // simply falls back to the legacy approve-time create path (new-submits-only compat),
  // while a draft can only exist alongside its request.
  //
  // BEST-EFFORT (log-and-continue, same posture as the approve-path listing writes):
  // the store listing is a convenience and must NEVER fail the primary submit. If the
  // draft create loses a rare slug race (P2002) the pre-check above missed, or hits a
  // transient DB error, the submit still succeeds — the author just can't set media
  // until approve mints the listing the legacy way. Only created for a first-version
  // submit that didn't reuse an existing orphan draft.
  if (createDraftListing) {
    try {
      const { buildListingScalarSync } = await import('./app-listing-mapper');
      const scalars = buildListingScalarSync({
        manifest,
        blockId: slug,
        category: typeof manifest.category === 'string' ? manifest.category : null,
      });
      await dbWrite.appListing.create({
        data: {
          id: newAppListingId(),
          kind: 'onsite',
          status: 'draft',
          slug,
          name: scalars.name,
          tagline: scalars.tagline,
          description: scalars.description,
          category: scalars.category,
          // Seed the maturity rating from the submitted manifest (approve re-syncs it
          // authoritatively from the AppBlock); default SFW so an omitted rating is never
          // mature. Drives the asset NSFW-scan threshold while pending.
          contentRating: typeof manifest.contentRating === 'string' ? manifest.contentRating : 'g',
          // No backing AppBlock until approve — the draft is tied to its pending request
          // purely by the shared, @unique slug.
          appBlockId: null,
          userId: submittedByUserId,
        },
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[submitVersion] pre-approval draft AppListing create failed (slug=${slug}); submit STANDS — ` +
          `the app is still reviewable and its store listing is minted at approve the legacy way, so the ` +
          `author sets media after approval instead of while pending: ${
            err instanceof Error ? err.message : String(err)
          }`
      );
    }
  }

  // Fire-and-forget Discord notify to the mod queue. Don't await — a
  // Discord outage must not block submissions.
  const submitter = await dbRead.user.findUnique({
    where: { id: submittedByUserId },
    select: { username: true },
  });
  void notifyModsOfNewRequest({
    slug,
    version,
    publishRequestId,
    submittedByUsername: submitter?.username ?? null,
    submittedByUserId,
    manifestDiffKind: manifestDiffSummary.kind === 'first-version' ? 'first-version' : 'update',
    fileChangeCounts: {
      added: fileSummary.added.length,
      changed: fileSummary.changed.length,
      removed: fileSummary.removed.length,
    },
  });

  return {
    publishRequestId,
    slug,
    version,
    bundleSha256,
    fileSummary,
    manifestDiffSummary,
  };
}

/**
 * Returns the current user's pending publish_request for `slug`, or null.
 * Powers the /apps/submit pre-flight check that surfaces a "withdraw and
 * resubmit" affordance when the dev is about to re-upload a bundle for a
 * slug they already have in the queue. Scoped to the caller's own rows
 * so other-user collisions don't leak request ids.
 */
export async function getMyPendingForSlug(opts: {
  slug: string;
  userId: number;
}): Promise<{ id: string; version: string; submittedAt: Date } | null> {
  const { dbRead } = await import('~/server/db/client');
  const { slug, userId } = opts;
  const row = await dbRead.appBlockPublishRequest.findFirst({
    where: { slug, status: 'pending', submittedByUserId: userId },
    select: { id: true, version: true, submittedAt: true },
  });
  return row ?? null;
}

/**
 * Stable, typed failure modes for {@link withdrawRequest}. Callers (the
 * `POST /api/v1/blocks/withdraw` endpoint, the `withdrawPublishRequest` tRPC
 * procedure) switch on `.code` rather than substring-matching the human
 * `message` — so the HTTP/TRPC status mapping can't silently drift if a
 * message string is reworded (a free-text `.includes('own')` map was an
 * ownership-oracle footgun). The `message` is preserved verbatim for logs +
 * the tRPC BAD_REQUEST passthrough.
 *
 *   - NOT_FOUND   — no such row.
 *   - NOT_OWNED   — the row exists but belongs to another user (the endpoint
 *                   collapses this to the SAME response as NOT_FOUND — never an
 *                   ownership oracle).
 *   - NOT_PENDING — the caller owns the row but it is no longer `pending`
 *                   (approved / rejected), so it cannot be withdrawn.
 */
export type WithdrawRequestErrorCode = 'NOT_FOUND' | 'NOT_OWNED' | 'NOT_PENDING';

export class WithdrawRequestError extends Error {
  readonly code: WithdrawRequestErrorCode;
  constructor(code: WithdrawRequestErrorCode, message: string) {
    super(message);
    this.name = 'WithdrawRequestError';
    this.code = code;
  }
}

/**
 * 🔴 Fix #1 (ONSITE reset coverage) — when an owner withdraws the block publish
 * request that `resetOnsiteListingToPending` re-queued, close the reset listing so the
 * owner can't defeat the mod's mandated re-review. This is the onsite mirror of the
 * offsite `closeTerminalListing` pending→removed+`delist` withdraw path.
 *
 * 🔴 DETERMINISTIC (mirrors the offsite `closeTerminalListing` rule): fires whenever an
 * ONSITE `AppListing` for this slug is currently `pending` — which is ALWAYS a mod
 * reset. Onsite listings are created `approved` on approve; the ONLY writer of
 * `status='pending'` on an onsite listing is `resetOnsiteListingToPending`, so a
 * `pending` onsite listing == a mod-mandated re-review. It therefore does NOT probe the
 * most-recent moderation event (an intervening report-resolve/dismiss event on the same
 * listing could shift the newest event off `reset-to-pending` and defeat such a probe).
 * Flip the listing `pending → removed` (status-guarded TOCTOU) + write a `delist` audit
 * event with the OWNER as actor: the last event is now a takedown, so
 * `republishOwnListing`'s guard FORBIDS the owner and a mod must `relistListing`
 * (`removed → approved`, which also un-suspends the backing block). The block is left
 * `suspended` (already so from the reset) — correct, relist restores it.
 *
 * A first-time submission withdraw (no approved listing yet → no `pending` onsite
 * listing) is a no-op.
 */
async function closeOnsiteResetListingOnWithdraw(opts: {
  slug: string;
  actorUserId: number;
}): Promise<void> {
  const { dbRead, dbWrite } = await import('~/server/db/client');

  const listing = await dbRead.appListing.findFirst({
    where: { slug: opts.slug, kind: 'onsite', status: 'pending' },
    select: { id: true, slug: true },
  });
  if (!listing) return; // not a reset withdraw (first-time submission, or already closed)

  // A `pending` onsite listing is unconditionally a mod reset → close it. Imported here
  // (only on the rare reset branch) to keep the common no-reset withdraw path free of
  // the id-gen module.
  const { newAppListingModerationEventId } = await import('~/server/utils/app-block-ids');
  await dbWrite.$transaction(async (tx) => {
    const flipped = await tx.appListing.updateMany({
      where: { id: listing.id, kind: 'onsite', status: 'pending' },
      data: { status: 'removed' },
    });
    if (flipped.count === 0) return; // raced (mod re-approved/relisted) → leave as-is
    await tx.appListingModerationEvent.create({
      data: {
        id: newAppListingModerationEventId(),
        appListingId: listing.id,
        slug: listing.slug,
        action: 'delist',
        actorUserId: opts.actorUserId,
        reason: null,
        before: { status: 'pending' },
        after: { status: 'removed' },
      },
    });
  });
}

/**
 * W13 draft-at-submit cleanup — on REJECT or WITHDRAW of a first-version on-site
 * publish request, delete the pre-approval DRAFT `AppListing` minted at submit so the
 * store slug is released and the unreviewed media is discarded. Mirrors the off-site
 * `closeTerminalListing` draft branch: a status-guarded `deleteMany` (`status:'draft'`)
 * can never remove an approved/removed row; `AppListingScreenshot` is
 * `onDelete: Cascade` so screenshots go with it, and the underlying `Image` rows are
 * `onDelete: SetNull` (DETACHED, not hard-deleted — same as off-site). Resolved BY SLUG
 * (no request→listing FK). No-op for a subsequent-version request (no such draft), an
 * already-cleaned draft, or a legacy pre-ship pending request.
 */
async function deleteOnsiteDraftListingForSlug(opts: { slug: string }): Promise<void> {
  const { dbWrite } = await import('~/server/db/client');
  await dbWrite.appListing.deleteMany({
    where: { slug: opts.slug, kind: 'onsite', appBlockId: null, status: 'draft' },
  });
}

/**
 * Dev-facing withdrawal of their own pending request. Idempotent
 * (re-withdrawing is a no-op if already withdrawn). Throws a typed
 * {@link WithdrawRequestError} on a missing row, another user's row, or a
 * non-`pending` row.
 *
 * CONCURRENCY (audit S1 — TOCTOU): the `findUnique` only CLASSIFIES the
 * outcome; the actual mutation is a status-guarded `updateMany` keyed on
 * `{ id, status: 'pending' }`, so a withdraw that read `pending` can no longer
 * clobber a row a concurrent `approveRequest` flipped to `approved` between the
 * read and the write (which would desync the live block from its request row
 * and silently break the deploy state machine — `markRequestDeployState`
 * filters on `status='approved'`). If the guarded write matches 0 rows despite
 * the earlier pending classification, we re-read and resolve the race: now
 * `withdrawn` → idempotent success; now `approved`/`rejected` → NOT_PENDING.
 * This makes the "refuses to withdraw a non-pending request" guarantee TRUE
 * under concurrency.
 *
 * NOTE: a withdraw landing in the MIDDLE of an in-flight `approveRequest` (the
 * dev withdraws at the exact instant a mod approves) can still leave an
 * approved/withdrawn split — that direction is mod-initiated, lower severity,
 * pre-existing, and NOT worsened here; the dangerous scriptable
 * (dev-self-service) direction is the one closed by the guard above. Tracked as
 * a follow-up to harden `approveRequest` symmetrically.
 */
export async function withdrawRequest(opts: {
  publishRequestId: string;
  userId: number;
}): Promise<void> {
  const { dbRead, dbWrite } = await import('~/server/db/client');
  const { publishRequestId, userId } = opts;
  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: publishRequestId },
    // deployState (#2831): a dev who self-withdraws a request they previewed must
    // also tear down the review env — otherwise the review Deployment/IngressRoute
    // orphans (the apply Job's ttlSecondsAfterFinished only reaps the Job, not the
    // workloads it applied). Captured here so we can fire teardownReviewForRequest
    // after the withdraw lands.
    // `slug` (Fix #1 onsite coverage): a withdraw of a mod-mandated reset re-queue must
    // close the reset listing so the owner can't defeat the re-review — see below.
    select: { id: true, status: true, submittedByUserId: true, deployState: true, slug: true },
  });
  if (!row) {
    throw new WithdrawRequestError('NOT_FOUND', `publish request ${publishRequestId} not found`);
  }
  if (row.submittedByUserId !== userId) {
    throw new WithdrawRequestError('NOT_OWNED', 'you can only withdraw your own publish requests');
  }
  if (row.status === 'withdrawn') return;
  if (row.status !== 'pending') {
    throw new WithdrawRequestError(
      'NOT_PENDING',
      `cannot withdraw a request in status ${row.status}`
    );
  }
  const hadReviewPreview =
    typeof row.deployState === 'string' && row.deployState.startsWith('preview-');

  // Status-guarded write: only flip a STILL-`pending` row. This is the atomic
  // step that closes the TOCTOU window against a concurrent approve.
  const { count } = await dbWrite.appBlockPublishRequest.updateMany({
    where: { id: publishRequestId, status: 'pending' },
    data: { status: 'withdrawn' },
  });
  if (count > 0) {
    // 🔴 Fix #1 (ONSITE coverage): if this withdrawn request was a MOD-MANDATED reset
    // re-queue (`resetOnsiteListingToPending` bounced an approved onsite listing to
    // `pending` + suspended the block + cloned this pending request), the owner
    // withdrawing it must NOT leave them able to defeat the re-review. Close the reset
    // listing to `removed` + write a `delist` event (the onsite mirror of the offsite
    // `closeTerminalListing` withdraw path) so `republishOwnListing`'s guard FORBIDS an
    // owner self-restore — a mod must `relistListing` (which also un-suspends the
    // block). A first-time submission withdraw has no `pending` onsite listing → no-op.
    await closeOnsiteResetListingOnWithdraw({ slug: row.slug, actorUserId: userId });
    // W13 draft-at-submit — also delete a FIRST-version pre-approval DRAFT listing
    // (disjoint from the reset case above, which targets a `pending` on-site listing;
    // a first-time draft is `status='draft'`). Release the slug + drop unreviewed
    // media. Best-effort: the withdraw has already committed, so a cleanup failure must
    // never fail the outcome (the slug stays reserved until a later cleanup / mod
    // delete — recoverable).
    try {
      await deleteOnsiteDraftListingForSlug({ slug: row.slug });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[withdrawRequest] pre-approval draft cleanup failed (id=${publishRequestId}, slug=${row.slug}); ` +
          `withdraw STANDS: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // MOD REVIEW SANDBOX (#2831) — tear down any review env spun up for this
    // request. Best-effort + non-blocking (mirrors approveRequest/rejectRequest):
    // the withdraw has already committed, so a teardown failure must never affect
    // the outcome. Gated on a preview actually having been started so the common
    // no-preview withdraw does zero extra k8s work.
    if (hadReviewPreview) void teardownReviewForRequest(publishRequestId);
    // AGENTIC REVIEW (P1, audit #1) — tear down any review AGENT UNCONDITIONALLY:
    // an agent can run without a sandbox preview, so this must not be gated on
    // hadReviewPreview. Idempotent no-op when no agent was dispatched.
    void teardownAgentReviewForRequest(publishRequestId);
    return;
  }
  if (count === 0) {
    // The row changed under us between the classify-read and the guarded write
    // (lost the race). Re-read from the PRIMARY (`dbWrite`) — a replica read
    // could be lag-stale and still report `pending`, which would mis-resolve
    // the race — and decide the authoritative outcome.
    const after = await dbWrite.appBlockPublishRequest.findUnique({
      where: { id: publishRequestId },
      select: { status: true },
    });
    if (!after || after.status === 'withdrawn') {
      // Raced into withdrawn (or vanished) → idempotent success, no throw. Still
      // fire the review teardown (idempotent) in case THIS call observed a
      // preview but a concurrent withdraw committed first without tearing it down.
      if (hadReviewPreview) void teardownReviewForRequest(publishRequestId);
      // AGENTIC REVIEW (P1, audit #1) — unconditional agent teardown (idempotent).
      void teardownAgentReviewForRequest(publishRequestId);
      return;
    }
    // Raced into approved/rejected → the not-pending guarantee, now true under
    // concurrency.
    throw new WithdrawRequestError(
      'NOT_PENDING',
      `cannot withdraw a request in status ${after.status}`
    );
  }
}

/**
 * Files the build pipeline OWNS + injects at build time (audit A8/BUILD-1
 * Phase 2). The pipeline ignores any tenant-supplied Dockerfile/nginx.conf and
 * builds with its own platform-owned recipe, so we don't commit tenant copies
 * to the canonical build-source repo (civitai-apps/<slug>) — they'd be inert +
 * misleading. Matched case-insensitively at the repo root only. (The in-review
 * snapshot + the diff summary keep the full upload so mods see what was sent.)
 */
function isPlatformOwnedPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === 'dockerfile' || lower === 'nginx.conf';
}

/**
 * Re-fetch the bundle from MinIO and extract path → content map. Used
 * during approve to push files to Forgejo. Returns Buffer per file (we
 * need binary fidelity for non-text files).
 */
/** Fetch the raw bundle ZIP bytes from MinIO by key. */
async function fetchBundleBuffer(bundleKey: string): Promise<Buffer> {
  const { getBundleBucket, getBundleS3Client } = await import('~/utils/bundle-s3');
  const client = getBundleS3Client();
  const obj = await client.send(
    new GetObjectCommand({ Bucket: getBundleBucket(), Key: bundleKey })
  );
  if (!obj.Body) throw new Error(`bundle ${bundleKey} not found in S3`);
  const bytes = await obj.Body.transformToByteArray();
  return Buffer.from(bytes);
}

/** Extract every file's bytes from an in-memory bundle ZIP, re-applying the
 *  per-file + running-aggregate caps via the streaming reader. */
async function extractBundleFilesFromBuffer(
  bundleBuffer: Buffer
): Promise<Array<{ path: string; content: Buffer }>> {
  const zip = await JSZip.loadAsync(bundleBuffer);
  const out: Array<{ path: string; content: Buffer }> = [];
  // Defense-in-depth: re-apply per-file + running-aggregate caps via the same
  // streaming reader. This reads our own already-validated stored bundle so
  // it's lower-risk, but it bounds the all-files-in-memory array all the same.
  let totalBytes = 0;
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    const content = await readZipEntryCapped(entry, {
      maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
      remainingTotalBytes: MAX_TOTAL_DECOMPRESSED_BYTES - totalBytes,
      maxTotalBytes: MAX_TOTAL_DECOMPRESSED_BYTES,
      path,
    });
    totalBytes += content.length;
    out.push({ path, content });
  }
  return out;
}

async function fetchAndExtractBundleFiles(
  bundleKey: string
): Promise<Array<{ path: string; content: Buffer }>> {
  const bundleBuffer = await fetchBundleBuffer(bundleKey);
  return extractBundleFilesFromBuffer(bundleBuffer);
}

/**
 * Reconstruct a bundle ZIP Buffer from the live Forgejo repo at a given ref.
 *
 * Used by:
 *   - `approveRequest` for a PUSH-ORIGINATED publish request (one the git-push
 *     webhook parked with empty bundle pointers + a real forgejoCommitSha — the
 *     ZIP was never uploaded, so the Forgejo repo at that sha IS the artifact);
 *   - `backfillPublishRequest` to snapshot an existing live app's current HEAD.
 *
 * `ref` is any git ref the Forgejo tree endpoint resolves — a branch name OR a
 * commit SHA. The push path passes the exact pushed sha so the reconstructed
 * bytes match the reviewed commit, not a since-moved branch HEAD.
 *
 * The ZIP is built deterministically (`date: new Date(0)`, entries added in
 * sorted path order) so the same repo state always produces the same bytes →
 * a stable bundleSha256. Blobs are fetched with bounded concurrency (8 in
 * flight) to avoid hammering Forgejo on large repos.
 */
export async function reconstructBundleFromForgejo(slug: string, ref: string): Promise<Buffer> {
  const { listRepoTreeAtRef, getBlobContent } = await import('./forgejo.service');

  // Snapshot the blob tree at the exact ref (commit sha or branch).
  const tree = await listRepoTreeAtRef(slug, ref);
  // Sort by path so the ZIP entry order — and thus the resulting bytes /
  // bundleSha256 — is deterministic regardless of Forgejo's tree ordering.
  const entries = Array.from(tree.entries())
    .map(([path, blobSha]) => ({ path, blobSha }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const CONCURRENCY = 8;
  const files: Array<{ path: string; content: Buffer }> = [];
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(
      batch.map(async (e) => ({
        path: e.path,
        content: await getBlobContent(slug, e.blobSha),
      }))
    );
    files.push(...fetched);
  }

  // Build an in-memory ZIP — same shape a developer would have uploaded.
  // `date: new Date(0)` zeroes per-entry timestamps so re-runs with identical
  // repo state produce an identical bundleSha256 (mirrors backfill).
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.content, { date: new Date(0) });
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

export type ListPendingRequestsOptions = {
  limit?: number;
  cursor?: string;
};

/**
 * Compute the file + manifest diff for a PUSH-ORIGINATED publish request from
 * the live Forgejo repo at the pushed ref.
 *
 * The git-push webhook never receives a ZIP, so without this the parked review
 * stores a 0-file summary + a misleading "first-version" manifest diff and the
 * mod approves blind. We reconstruct the bundle from Forgejo (the same bytes
 * approve will build) and run the IDENTICAL extract+diff pipeline submitVersion
 * uses, so the diff is faithful (content-sha256 based) and correctly labelled
 * first-version vs update against the previous approved version.
 */
export async function computePushDiffSummaries(
  slug: string,
  ref: string
): Promise<{
  fileSummary: FileSummary;
  manifestDiffSummary: ManifestDiffSummary;
  bundleSizeBytes: number;
}> {
  const bundleBuffer = await reconstructBundleFromForgejo(slug, ref);
  const { files, manifest } = await extractBundleMetadata(bundleBuffer);
  const previous = await getPreviousApprovedState(slug);
  return {
    fileSummary: computeFileDiff(files, previous?.files ?? null),
    manifestDiffSummary: computeManifestDiff(
      manifest as Record<string, unknown>,
      previous?.manifest ?? null
    ),
    bundleSizeBytes: bundleBuffer.length,
  };
}

/**
 * Best-effort, OFF-the-webhook-response-path enrichment of a parked
 * push-originated review row. The git-push webhook parks the row FAST with an
 * empty summary (so the response isn't blocked on a full Forgejo bundle
 * reconstruct, and the supersede→create window stays tiny), then fires this
 * fire-and-forget to fill in the real file/manifest diff + bundle size.
 *
 * NEVER throws (a failure leaves the empty summary + the working "View code in
 * Forgejo @ sha" link — a re-push re-parks + re-enriches). Scoped to
 * status='pending' so it can't clobber a row a mod approved/rejected — or
 * another push superseded — in the meantime. Deliberately does NOT touch
 * bundleKey / bundleSha256: those stay empty as the push-originated marker.
 */
export async function enrichPushRequestRow(
  publishRequestId: string,
  slug: string,
  ref: string
): Promise<void> {
  try {
    const { fileSummary, manifestDiffSummary, bundleSizeBytes } =
      await computePushDiffSummaries(slug, ref);
    const { dbWrite } = await import('~/server/db/client');
    await dbWrite.appBlockPublishRequest.updateMany({
      where: { id: publishRequestId, status: 'pending' },
      data: {
        fileSummary: fileSummary as object,
        manifestDiffSummary: manifestDiffSummary as object,
        bundleSizeBytes: BigInt(bundleSizeBytes),
      },
    });
  } catch (e) {
    console.error(
      `[push-enrich] failed for ${slug}@${ref} (${publishRequestId}), leaving empty summary:`,
      String(e).slice(0, 240)
    );
  }
}

/**
 * Record (or refresh) a `pending` publish request for an UNREVIEWED commit to
 * civitai-apps/<slug>:main. This is the canonical no-trust-on-push gate: a
 * direct git push OR a background commit (e.g. the web manifest editor) cannot
 * auto-approve or deploy, so we capture it as the same kind of review artifact a
 * submitVersion produces and leave it for a moderator.
 *
 * The bundle bytes are NOT available here (the only inputs are the commit sha +
 * the manifest at that sha), so this row's bundle pointers are left empty and a
 * `forgejoCommitSha` is stored instead — a moderator reviews the code in the
 * Forgejo repo directly. `approveRequest` already supports approving a `pending`
 * request against the existing app_blocks row. The empty `bundleKey` is the
 * durable PUSH-ORIGINATED marker (distinguishes a manifest-edit / git-push from
 * a ZIP submitVersion).
 *
 * Idempotent at the (slug, sha) level: a re-delivery of the same commit (e.g.
 * the git-push webhook AND an explicit caller both invoking this for the same
 * sha) refreshes the existing pending row rather than stacking duplicates. Only
 * ONE pending request per slug is allowed (matches the submitVersion invariant +
 * the partial unique index), so a newer unreviewed sha supersedes an older
 * still-pending one. Returns the publish-request id so a UI caller can deep-link
 * the submitter to it.
 *
 * Extracted from the git-push webhook handler so both the webhook and the web
 * manifest editor share ONE recorder (and one gate). The webhook still calls
 * this; the editor calls it explicitly after its commit so it gets a stable
 * publishRequestId back without depending on webhook delivery.
 */
export async function recordPendingFromPush(args: {
  slug: string;
  sha: string;
  appBlockId: string;
  manifest: object;
  version: string;
}): Promise<{ publishRequestId: string }> {
  const [{ dbWrite, dbRead }, { newUlid }] = await Promise.all([
    import('~/server/db/client'),
    import('~/server/utils/app-block-ids'),
  ]);

  // Already captured this exact (slug, sha) as pending? Refresh + done.
  const existingForSha = await dbWrite.appBlockPublishRequest.findFirst({
    where: { slug: args.slug, status: 'pending', forgejoCommitSha: args.sha },
    select: { id: true },
  });
  if (existingForSha) {
    await dbWrite.appBlockPublishRequest.update({
      where: { id: existingForSha.id },
      data: { manifest: args.manifest, version: args.version, appBlockId: args.appBlockId },
    });
    return { publishRequestId: existingForSha.id };
  }

  // Supersede any OTHER still-pending request for this slug (older sha or a
  // dev submitVersion) so the partial unique index (one pending per slug)
  // doesn't reject the insert and the queue shows the newest unreviewed sha.
  await dbWrite.appBlockPublishRequest.updateMany({
    where: { slug: args.slug, status: 'pending' },
    data: { status: 'withdrawn' },
  });

  // Attribute the row to the app owner (OauthClient.userId). submittedByUserId
  // is required + FK-constrained, and the owner is the most meaningful actor for
  // a commit to their repo.
  const ownerRow = await dbRead.appBlock.findUnique({
    where: { id: args.appBlockId },
    select: { app: { select: { userId: true } } },
  });
  const ownerUserId = ownerRow?.app?.userId;
  if (typeof ownerUserId !== 'number') {
    throw new Error(`could not resolve owner userId for appBlock ${args.appBlockId}`);
  }
  const publishRequestId = `pubreq_${newUlid()}`;

  // Park the review IMMEDIATELY with an empty summary, then enrich the real
  // file/manifest diff OFF the response path (below). The empty summary is the
  // durable fallback if enrichment never lands.
  //
  // RACE (audit follow-up): `updateManifest` calls this explicitly AND the
  // Forgejo push webhook the same commit fires ALSO calls it for the same
  // (slug, sha). Both can miss the `existingForSha` read above and both reach
  // this create. The partial unique index
  // `app_block_publish_requests_one_pending_per_slug` ((slug) WHERE
  // status='pending') makes the loser's INSERT trip a P2002 — catch it, re-read
  // the winner's pending row, and return it (the loser no-ops gracefully
  // instead of throwing). NOTE: unlike submitVersion's C-4 catch (which THROWS
  // a human-readable conflict error on P2002), this races to record the SAME
  // commit, so the right outcome is to return the winner's id, not to surface a
  // conflict — a same-commit re-delivery must be idempotent, not an error.
  try {
    await dbWrite.appBlockPublishRequest.create({
      data: {
        id: publishRequestId,
        appBlockId: args.appBlockId,
        slug: args.slug,
        submittedByUserId: ownerUserId,
        version: args.version,
        manifest: args.manifest,
        // No bundle: the Forgejo repo at forgejoCommitSha IS the reviewable
        // artifact; mods browse it directly. bundleKey stays empty as the
        // push-originated marker.
        bundleKey: '',
        bundleSha256: '',
        bundleSizeBytes: BigInt(0),
        fileSummary: { files: [], added: [], removed: [], changed: [] },
        manifestDiffSummary: {
          kind: 'first-version' as const,
          fields: Object.keys(args.manifest as Record<string, unknown>).sort(),
        },
        status: 'pending',
        forgejoCommitSha: args.sha,
      },
    });
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code !== 'P2002') throw err;
    // Lost the race: another concurrent recorder for this slug already parked a
    // pending row. Re-read it and return it so this caller no-ops gracefully.
    // Prefer the exact-sha row (this commit), falling back to whatever pending
    // row exists for the slug (the winner may have parked a newer sha).
    const winner =
      (await dbWrite.appBlockPublishRequest.findFirst({
        where: { slug: args.slug, status: 'pending', forgejoCommitSha: args.sha },
        select: { id: true },
      })) ??
      (await dbWrite.appBlockPublishRequest.findFirst({
        where: { slug: args.slug, status: 'pending' },
        select: { id: true },
      }));
    if (!winner) throw err; // index fired but no pending row visible — re-throw
    return { publishRequestId: winner.id };
  }

  // Fire-and-forget: fill in the real diff + bundle size. enrichPushRequestRow
  // has its own try/catch + is scoped to status='pending', so it never gates the
  // park and can't clobber a row that was approved/rejected/superseded.
  void enrichPushRequestRow(publishRequestId, args.slug, args.sha).catch(() => undefined);

  return { publishRequestId };
}

/**
 * Mod queue: paginated list of publish requests in status='pending',
 * oldest first (FIFO). Includes the submitter's basic profile so the
 * review UI doesn't round-trip per row.
 */
export async function listPendingRequests(opts: ListPendingRequestsOptions = {}) {
  const [{ dbRead }, { reviewRepoUrl, repoCommitUrl }] = await Promise.all([
    import('~/server/db/client'),
    import('./forgejo.service'),
  ]);
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appBlockPublishRequest.findMany({
    where: { status: 'pending' },
    orderBy: { submittedAt: 'asc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      appBlockId: true,
      slug: true,
      version: true,
      submittedAt: true,
      bundleSizeBytes: true,
      bundleSha256: true,
      manifest: true,
      fileSummary: true,
      manifestDiffSummary: true,
      forgejoCommitSha: true,
      submittedBy: { select: { id: true, username: true, image: true } },
    },
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return {
    items: items.map((r: (typeof rows)[number]) => ({
      ...r,
      // BigInt isn't JSON-serializable through tRPC's default transformer;
      // surface as a string. UI can format with Intl.NumberFormat.
      bundleSizeBytes: r.bundleSizeBytes.toString(),
      // Deep-link into the per-slug Forgejo review repo so mods can
      // browse the actual code from the review modal.
      reviewRepoUrl: reviewRepoUrl(r.slug),
      // PUSH-ORIGINATED requests have no review-org snapshot — link mods to the
      // CANONICAL repo at the exact pushed sha instead, so they can review the
      // real code rather than approve blind. Push rows are marked by empty
      // bundle pointers (recordPendingFromPush writes bundleKey='' AND
      // bundleSha256=''); bundleSha256 is already in this payload + NOT NULL, so
      // it's the discriminator here (the fetch paths key off the equivalent
      // bundleKey since they need the S3 path).
      pushCommitUrl:
        !r.bundleSha256 && r.forgejoCommitSha
          ? repoCommitUrl(r.slug, r.forgejoCommitSha)
          : null,
    })),
    nextCursor: hasNext ? items[items.length - 1].id : null,
  };
}

/**
 * Mod history: paginated list of publish requests in status='approved',
 * newest first (most recently reviewed). Includes both the submitter +
 * reviewer profiles plus the inline `approvalNotes` so the /apps/review
 * Approved tab doesn't round-trip per row.
 */
export async function listApprovedRequests(opts: ListPendingRequestsOptions = {}) {
  const [{ dbRead }, { reviewRepoUrl, repoCommitUrl }] = await Promise.all([
    import('~/server/db/client'),
    import('./forgejo.service'),
  ]);
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appBlockPublishRequest.findMany({
    where: { status: 'approved' },
    orderBy: { reviewedAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      appBlockId: true,
      slug: true,
      version: true,
      submittedAt: true,
      reviewedAt: true,
      approvalNotes: true,
      bundleSizeBytes: true,
      bundleSha256: true,
      manifest: true,
      fileSummary: true,
      manifestDiffSummary: true,
      forgejoCommitSha: true,
      // Build/deploy lifecycle — additive. The Approved tab is where a moderator
      // sees that an approved app never actually built (deployState null =
      // STRANDED) and can re-trigger it; without these three the queue shows a
      // uniformly-healthy list of approvals regardless of what actually shipped.
      deployState: true,
      deployDetail: true,
      deployUpdatedAt: true,
      submittedBy: { select: { id: true, username: true, image: true } },
      reviewedBy: { select: { id: true, username: true, image: true } },
    },
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return {
    items: items.map((r: (typeof rows)[number]) => ({
      ...r,
      bundleSizeBytes: r.bundleSizeBytes.toString(),
      reviewRepoUrl: reviewRepoUrl(r.slug),
      // Push rows have empty bundle pointers; bundleSha256 (selected, NOT NULL)
      // is the list-display discriminator (see listPendingRequests).
      pushCommitUrl:
        !r.bundleSha256 && r.forgejoCommitSha
          ? repoCommitUrl(r.slug, r.forgejoCommitSha)
          : null,
    })),
    nextCursor: hasNext ? items[items.length - 1].id : null,
  };
}

/**
 * Mod history: paginated list of publish requests in status='rejected',
 * newest first. Includes the rejecter profile + the required
 * `rejectionReason` so the /apps/review Rejected tab can show the inline
 * mod feedback without a second round-trip.
 */
export async function listRejectedRequests(opts: ListPendingRequestsOptions = {}) {
  const [{ dbRead }, { reviewRepoUrl, repoCommitUrl }] = await Promise.all([
    import('~/server/db/client'),
    import('./forgejo.service'),
  ]);
  const limit = Math.min(opts.limit ?? 25, 100);
  const rows = await dbRead.appBlockPublishRequest.findMany({
    where: { status: 'rejected' },
    orderBy: { reviewedAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      appBlockId: true,
      slug: true,
      version: true,
      submittedAt: true,
      reviewedAt: true,
      rejectionReason: true,
      bundleSizeBytes: true,
      bundleSha256: true,
      manifest: true,
      fileSummary: true,
      manifestDiffSummary: true,
      forgejoCommitSha: true,
      submittedBy: { select: { id: true, username: true, image: true } },
      reviewedBy: { select: { id: true, username: true, image: true } },
    },
  });
  const hasNext = rows.length > limit;
  const items = hasNext ? rows.slice(0, limit) : rows;
  return {
    items: items.map((r: (typeof rows)[number]) => ({
      ...r,
      bundleSizeBytes: r.bundleSizeBytes.toString(),
      reviewRepoUrl: reviewRepoUrl(r.slug),
      // Push rows have empty bundle pointers; bundleSha256 (selected, NOT NULL)
      // is the list-display discriminator (see listPendingRequests).
      pushCommitUrl:
        !r.bundleSha256 && r.forgejoCommitSha
          ? repoCommitUrl(r.slug, r.forgejoCommitSha)
          : null,
    })),
    nextCursor: hasNext ? items[items.length - 1].id : null,
  };
}

export type ApproveRequestParams = {
  publishRequestId: string;
  reviewerUserId: number;
  approvalNotes?: string;
};

export type ApproveRequestResult = {
  publishRequestId: string;
  appBlockId: string;
  forgejoCommitSha: string;
  isFirstVersion: boolean;
};

/**
 * Approve a pending publish request. End-to-end:
 *   1. (first version only) auto-create OauthClient owned by the submitter
 *   2. (first version only) create Forgejo repo from starter + webhook
 *   3. pre-insert app_blocks row (status='approved')
 *   4. fetch bundle from MinIO, extract files
 *   5. commitFiles to Forgejo (single atomic commit, replaceAllFiles=true)
 *   6. stamp app_blocks.current_version_sha = the committed sha + finalise
 *      publish_request → status='approved' (these are the moderator-approval
 *      markers the git-push webhook keys its no-trust-on-push gate off)
 *   7. trigger the Tekton build directly
 *
 * NO TRUST ON PUSH: the git-push webhook fires from step 5 but no longer
 * triggers builds. It only validates the manifest and either (a) no-ops
 * because the sha matches the approval markers we just wrote, or (b) parks
 * an unreviewed direct push as a pending review request. The deploy is owned
 * entirely by this approve path (step 7).
 *
 * Partial-state risk: if step 5 fails after step 1-3 succeeded, the
 * OauthClient + app_blocks rows are orphaned. v0 surfaces this; v1
 * adds a compensation transaction.
 */
export async function approveRequest(params: ApproveRequestParams): Promise<ApproveRequestResult> {
  const [{ dbRead, dbWrite }, { newUlid }, { env }] = await Promise.all([
    import('~/server/db/client'),
    import('~/server/utils/app-block-ids'),
    import('~/env/server'),
  ]);
  const { commitFiles, createRepoFromTemplate, ensurePushWebhook } = await import(
    './forgejo.service'
  );

  if (!env.FORGEJO_BASE_URL || !env.FORGEJO_ADMIN_TOKEN || !env.FORGEJO_WEBHOOK_SECRET) {
    throw new Error('Forgejo not configured');
  }

  const request = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: params.publishRequestId },
    select: {
      id: true,
      status: true,
      slug: true,
      version: true,
      manifest: true,
      bundleKey: true,
      // Push-originated requests (git-push webhook) carry an empty bundleKey
      // and this real sha — approve reconstructs the bundle from Forgejo at it.
      forgejoCommitSha: true,
      submittedByUserId: true,
      appBlockId: true,
      // MOD REVIEW SANDBOX (#2831) — read the current deploy_state so we can tell
      // (synchronously, before this approve flips it to a production value) whether
      // a review preview was ever started for this request. Only then do we fire
      // the teardown at the end. (deploy_state is null for the common no-preview
      // case, so teardown — and its k8s calls — are skipped entirely.)
      deployState: true,
    },
  });
  if (!request) throw new Error(`publish request ${params.publishRequestId} not found`);
  if (request.status !== 'pending') {
    throw new Error(`cannot approve a request in status ${request.status}`);
  }
  // Captured BEFORE markRequestDeployState below flips deploy_state to a
  // production 'building' value — drives the end-of-flow review teardown.
  const hadReviewPreview =
    typeof request.deployState === 'string' && request.deployState.startsWith('preview-');

  const manifest = request.manifest as Record<string, unknown>;
  // `manifestScopes` is written to `AppBlock.approvedScopes` on the three approve paths
  // below (create / P2002-retry / subsequent-version). 🔴 This mod-approval flow is the
  // ONLY place that writes `approvedScopes` — a load-bearing invariant the dev-tunnel
  // owned-non-approved mint relies on (block-tokens/index.ts): a NEVER-approved app has
  // `approvedScopes = []` ⟹ its dev token is read-only + cannot spend. Writing
  // `approvedScopes` anywhere OUTSIDE this approval flow would break that safety.
  const manifestScopes = Array.isArray(manifest.scopes) ? (manifest.scopes as string[]) : [];
  const manifestContentRating =
    typeof manifest.contentRating === 'string' ? manifest.contentRating : 'g';
  const manifestRenderMode =
    typeof manifest.renderMode === 'string' ? manifest.renderMode : 'iframe';
  // W13 category-on-approve: the OPTIONAL marketplace `category` the manifest
  // declares (already shape-validated below by BlockManifestValidator — if
  // present it is guaranteed a MARKETPLACE_CATEGORIES member; the guard here
  // narrows the type + is defense-in-depth). `null` when the manifest omits it.
  // Copied onto AppBlock.category ONLY when the row has no curated category yet
  // (no-clobber — see the updateMany just before the (3b) listing-create block).
  const manifestCategory = isMarketplaceCategory(manifest.category) ? manifest.category : null;

  // Determine first-vs-subsequent via the existing app_blocks row.
  // We don't rely on request.appBlockId being null because two requests
  // could land for the same slug before the first is approved.
  //
  // Pull the related OauthClient's allowedScopes + allowedOrigins so we
  // can feed the same AppContext to BlockManifestValidator that the
  // git-push webhook uses (audit H-4 — validate before any state writes
  // so a manifest the webhook would reject doesn't poison the
  // app_blocks row with content the build chain never accepts).
  const existingAppBlock = await dbRead.appBlock.findFirst({
    where: { blockId: request.slug },
    select: {
      id: true,
      appId: true,
      repoUrl: true,
      trustTier: true,
      app: { select: { allowedScopes: true, allowedOrigins: true } },
    },
  });
  const isFirstVersion = !existingAppBlock;

  // SECURITY: trust tier is moderator-controlled, NOT publisher-declared.
  // A manifest must never be able to self-escalate to `internal`/`verified`
  // (those tiers grant `allow-same-origin`, defeating the iframe sandbox).
  // New apps are always `unverified`; an existing app keeps whatever tier
  // is already on its row — raising it is a deliberate out-of-band
  // moderator/DB action, never a manifest field. (Was: defaulted a missing
  // manifest.trustTier to `internal`, the MOST privileged tier.)
  // Normalise the manifest's trustTier to the resolved value so the
  // validator below — which reads `manifest.trustTier` to gate the sandbox
  // allowlist — validates against the tier we'll actually persist, instead
  // of a self-declared one.
  const resolvedTrustTier = existingAppBlock?.trustTier ?? 'unverified';
  manifest.trustTier = resolvedTrustTier;

  // iframe.src is platform-owned (see manifest-normalize.ts). submitVersion
  // already stamped the canonical value, but re-stamp here so approve is also
  // correct for rows created before this change / via the backfill path. This
  // makes the value the validator (below), the app_blocks.manifest write, and
  // the committed block.manifest.json (step 5) all see consistent.
  stampCanonicalIframeSrc(manifest, request.slug, env.APPS_DOMAIN);

  // H-4 fix — run the same BlockManifestValidator the git-push webhook
  // runs, BEFORE any DB writes or the Forgejo commit. Without this:
  //   - app_blocks.manifest gets updated to the new manifest content
  //   - Forgejo commit fires the webhook
  //   - webhook 400s on the validator
  //   - publish_request is marked 'approved'
  //   - build chain never runs
  //   - row is left pointing at a manifest the live pod never serves
  // (Today's gen-from-model "sandbox token allow-popups-to-escape-
  // sandbox not allowed for trustTier=unverified" incident.)
  //
  // For first-version the OauthClient doesn't exist yet — synthesize
  // the AppContext that the create call (a few lines down) will
  // materialise. allowedScopes default is the Prisma schema default
  // (33554431 — every OAuth bit set on a newly-created client), which
  // matches what the webhook will see when it queries this row in a
  // few seconds. allowedOrigins matches the same per-app subdomain we
  // hardcode in the create.
  const { BlockManifestValidator } = await import(
    '~/server/services/block-manifest-validator.service'
  );
  // A1/A3/A4 fix: the OAuth ceiling for an app-block client is the bitmask
  // DERIVED from the manifest's declared scopes (intersection with the
  // OAuth-eligible bit set), NOT TokenScope.Full (33554431). Previously the
  // auto-provisioned client defaulted to all 25 bits, which (a) made it a
  // Full-scope authorization_code client → account-takeover primitive, and
  // (b) rendered this very manifest scope gate inert (every manifest scope is
  // trivially within an all-bits ceiling). Feeding the derived ceiling here
  // means the validator below enforces a real subset check, and it matches
  // exactly what we write to OauthClient.allowedScopes in the create.
  const derivedOauthCeiling = deriveOauthBitmaskFromBlockScopes(manifestScopes);
  const validationCtx = isFirstVersion
    ? {
        allowedScopes: derivedOauthCeiling,
        allowedOrigins: [`https://${request.slug}.${env.APPS_DOMAIN}`],
      }
    : {
        // On a subsequent version the live client still carries whatever
        // ceiling the previous approve set. Re-derive from THIS manifest and
        // union with the existing ceiling so the validator validates against
        // the ceiling we'll actually persist below (we re-cap allowedScopes to
        // the derived value on every approve — see the appBlock.update path).
        allowedScopes: derivedOauthCeiling,
        allowedOrigins: (existingAppBlock!.app.allowedOrigins ?? []).map((o: string) =>
          o.toLowerCase()
        ),
      };
  // APPROVE is a re-validation of the ALREADY-SUBMITTED manifest, not a new
  // submit — exempt ONLY the new sensitive-scope-justification enforcement so a
  // LEGACY pending request (submitted before that rule shipped, sensitive scope
  // + no justification) stays approvable. Every OTHER manifest check still runs
  // here (the H-4 invariant). A post-deploy submission already passed this gate
  // at submit time, and nothing reaches the approve queue without the submit
  // gate first, so skipping the re-check creates no bypass.
  const validation = await BlockManifestValidator.validateSubmission(manifest, validationCtx, {
    enforceSensitiveScopeJustification: false,
  });
  if (!validation.valid) {
    throw new Error(
      `Invalid manifest — cannot approve. The git-push webhook would reject this manifest with the same errors and the build chain would not run. ` +
        `Details: ${validation.errors.slice(0, 5).join('; ')}`
    );
  }

  let appBlockId: string;
  let repoUrl: string;

  if (isFirstVersion) {
    // (1) Auto-create OauthClient — public client scoped to the per-app
    // subdomain so the existing git-push manifest validator passes the
    // H8 origin binding check.
    //
    // **Deterministic id** (`appblk-<slug>`) is load-bearing for retry
    // safety: if approve fails mid-flow and the mod re-clicks Approve,
    // the second oauthClient.create hits the PK unique constraint
    // (P2002) and we fall through to findUnique — no orphan client
    // accumulating across retries. Audit C-2 (claudedocs/app-blocks-
    // w1-v0-audit-2026-05-28.md) tracks the rationale.
    //
    // **Also blunts C-3**: two concurrent first-version approves for
    // the same slug now collide at the OauthClient PK rather than each
    // inserting a distinct OauthClient + AppBlock row.
    const oauthClientId = `appblk-${request.slug}`;
    const oauthClientName =
      typeof manifest.name === 'string' && manifest.name.length > 0
        ? manifest.name.slice(0, 80)
        : `App Block: ${request.slug}`;
    try {
      await dbWrite.oauthClient.create({
        data: {
          id: oauthClientId,
          secret: null,
          name: oauthClientName,
          description: '',
          redirectUris: [],
          allowedOrigins: [`https://${request.slug}.${env.APPS_DOMAIN}`],
          isConfidential: false,
          userId: request.submittedByUserId,
          // A1 fix — structurally non-interactive client.
          //  - grants:[] removes the Prisma default
          //    ["authorization_code","refresh_token"], so this row can never
          //    drive the interactive OAuth flow that mints account Bearer
          //    tokens. (The authorize/device endpoints + oauthClient.router
          //    also hard-reject `appblk-*` ids as defense-in-depth.)
          //  - allowedScopes is the manifest-derived ceiling, NOT
          //    TokenScope.Full. This is the policy ceiling for block-token
          //    minting (block-tokens/index.ts intersects against it).
          grants: [],
          allowedScopes: derivedOauthCeiling,
        },
      });
    } catch (err) {
      // Duck-type on Prisma's error shape rather than instanceof —
      // matches the pattern used by buzz-attribution.service.ts.
      const code = (err as { code?: unknown })?.code;
      if (code !== 'P2002') throw err;
      const existing = await dbRead.oauthClient.findUnique({
        where: { id: oauthClientId },
        select: { id: true },
      });
      if (!existing) {
        // P2002 without a hit on findUnique would indicate a foreign
        // unique constraint we don't know about; surface the original.
        throw err;
      }
      // A1 fix — converge an already-existing app-block client to the
      // structurally-safe shape on this retry. This also self-heals any row
      // created by an earlier code version with the all-bits Full default and
      // the inherited interactive grants.
      await dbWrite.oauthClient.update({
        where: { id: oauthClientId },
        data: { grants: [], allowedScopes: derivedOauthCeiling },
      });
    }

    // (2) Create Forgejo repo seeded from the starter + push webhook.
    // createRepoFromTemplate is idempotent (returns existing on 409);
    // ensurePushWebhook lists + replaces existing hooks so the second
    // call doesn't stack.
    const repo = await createRepoFromTemplate({
      slug: request.slug,
      description: oauthClientName,
      template: 'starter',
    });
    repoUrl = repo.html_url;
    const callbackUrl = `${(process.env.NEXTAUTH_URL ?? '').replace(
      /\/$/,
      ''
    )}/api/internal/blocks/git-push`;
    await ensurePushWebhook({
      slug: request.slug,
      callbackUrl,
      secret: env.FORGEJO_WEBHOOK_SECRET,
    });

    // (3) Insert app_blocks row so the downstream git-push handler finds
    // it. status='approved' + repoUrl populated; currentVersionSha gets
    // filled in by the webhook after the Forgejo commit.
    //
    // Retry-safe via the (appId, blockId) unique constraint: a second
    // approve hits P2002 here and falls through to findFirst.
    appBlockId = `apb_${newUlid()}`;
    try {
      await dbWrite.appBlock.create({
        data: {
          id: appBlockId,
          appId: oauthClientId,
          blockId: request.slug,
          version: request.version,
          manifest: manifest as object,
          status: 'approved',
          contentRating: manifestContentRating,
          renderMode: manifestRenderMode,
          trustTier: resolvedTrustTier,
          approvedScopes: manifestScopes,
          repoUrl,
        },
      });
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code !== 'P2002') throw err;
      const existing = await dbRead.appBlock.findFirst({
        where: { appId: oauthClientId, blockId: request.slug },
        select: { id: true },
      });
      if (!existing) throw err;
      appBlockId = existing.id;
      // Refresh the manifest + version on the existing row so retries
      // converge to the new state (the failed earlier attempt may have
      // had different content).
      await dbWrite.appBlock.update({
        where: { id: appBlockId },
        data: {
          version: request.version,
          manifest: manifest as object,
          status: 'approved',
          contentRating: manifestContentRating,
          renderMode: manifestRenderMode,
          trustTier: resolvedTrustTier,
          approvedScopes: manifestScopes,
          repoUrl,
        },
      });
    }
  } else {
    appBlockId = existingAppBlock.id;
    repoUrl = existingAppBlock.repoUrl ?? '';
    // Subsequent version: refresh manifest + version + approvedScopes
    // on the existing row. currentVersionSha is stamped in step (6) below,
    // right after the Forgejo commit returns the approved sha.
    await dbWrite.appBlock.update({
      where: { id: appBlockId },
      data: {
        manifest: manifest as object,
        version: request.version,
        approvedScopes: manifestScopes,
        contentRating: manifestContentRating,
        renderMode: manifestRenderMode,
        trustTier: resolvedTrustTier,
      },
    });
    // A1 fix — keep the OauthClient ceiling in sync with the newly-approved
    // manifest. Re-cap to the derived bitmask so the policy ceiling never
    // exceeds what this version's manifest declares, and force grants:[] so an
    // older row created before this fix (Full + interactive grants) is
    // self-healed on its next approve. This is byte-for-byte scoped to the
    // app-block client (existingAppBlock.appId is the `appblk-<slug>` id).
    await dbWrite.oauthClient.update({
      where: { id: existingAppBlock.appId },
      data: { grants: [], allowedScopes: derivedOauthCeiling },
    });
  }

  // (3a) Category-on-approve (W13 follow-up to (3b)) — populate AppBlock.category
  // from the validated manifest `category` so it flows to the auto-created store
  // listing below WITHOUT any change to (3b)/`mapAppBlockToListing` (they already
  // read AppBlock.category). NO-CLOBBER + read-your-writes, done as ONE atomic
  // write across every path (first-version create, P2002-retry, subsequent
  // version): a targeted `updateMany` gated on `category: null` sets it ONLY when
  // no category is present yet. This is immune to replica lag (the gate is
  // evaluated at the PRIMARY, unlike the `dbRead` row read above) and guarantees
  // a moderator's curated category (set via `setMarketplaceMeta`) is never
  // overridden by a re-approve. Skipped entirely when the manifest declares no
  // category (the row keeps whatever it had — null for a fresh app). Runs BEFORE
  // the (3b) block's `dbWrite.appBlock.findUnique` re-read (same PRIMARY), so the
  // listing-create reads the just-written category (read-your-writes). A first-
  // version approve whose manifest declares a category therefore mints a listing
  // already categorised; a manifest with no category leaves it null (mod-curated
  // later). The "category added in a LATER version" case (the listing already
  // exists) is now HANDLED — the (3b-sync) re-sync below propagates this column
  // onto the existing listing on a subsequent-version approve. This null-gate is
  // also what makes sourcing the re-sync's `category` from HERE safe: a curated
  // value is never overwritten above, so propagating it can't undo curation.
  if (manifestCategory !== null) {
    try {
      await dbWrite.appBlock.updateMany({
        where: { id: appBlockId, category: null },
        data: { category: manifestCategory },
      });
    } catch (err) {
      // Same posture as the (3b) listing-create below (and #3085): the category
      // FEEDS the convenience store listing, so it must NEVER gate the
      // approve/deploy. On ANY error (transient DB blip, etc.) log-and-CONTINUE
      // — the app still deploys, the category is simply absent this pass and is
      // recoverable on a re-approve (the null-gate re-applies idempotently) or
      // via mod curation. If we rethrew, a deterministically-failing write here
      // could wedge the app's deploy forever over a mere categorisation miss.
      // eslint-disable-next-line no-console
      console.warn(
        `[approveRequest] category-from-manifest set failed (slug=${request.slug}, appBlockId=${appBlockId}); ` +
          `approve/deploy CONTINUES — AppBlock.category is unset this pass, recoverable on re-approve or via mod curation: ${
            err instanceof Error ? err.message : String(err)
          }`
      );
    }
  }

  // (3b) App Store listing (W13) — auto-create the onsite `AppListing` for this
  // app so an approved+deployed onsite app shows on the `/apps` store grid
  // WITHOUT a manual `backfillAppListings` run. This closes the W13-LOCKED
  // "1:1 slug=blockId auto-create-on-approve" decision that was never wired.
  //
  // TRANSACTION BOUNDARY: approveRequest is NOT a DB transaction — it interleaves
  // durable DB writes with Forgejo/MinIO/Tekton I/O and is made correct by
  // deterministic ids + P2002-fallback so a partial-failure re-approve converges
  // (the OauthClient + AppBlock creates above use exactly this pattern). We slot
  // the listing create into that same model: run it right after the AppBlock row
  // exists, using the same client, WHILE THE PUBLISH_REQUEST IS STILL 'pending'
  // (it is finalised 'approved' only in step 6, after the commit succeeds). So a
  // failure in ANY later step (bundle fetch / commit / build) leaves the request
  // pending → the mod re-approves → this block idempotently SKIPS the existing
  // listing and the flow converges. The listing is never permanently orphaned.
  //
  // IDEMPOTENT on `appBlockId` (the 1:1 unique): first-version approve CREATES it;
  // a subsequent-version approve finds it present and RE-SYNCS only the
  // MANIFEST-GOVERNED scalars (see (3b-sync) below). A concurrent create (a racing
  // approve or the backfill) is absorbed by the P2002 catch.
  //
  // ONSITE ONLY: approveRequest only ever produces hosted (external_url IS NULL)
  // AppBlocks, so `mapAppBlockToListing` yields kind='onsite'. The offsite
  // external-submission flow (`offsite-listing.service`) owns its own listing
  // writes — this path never touches it and never double-creates.
  //
  // We read the freshly-approved AppBlock's OWN columns from the PRIMARY
  // (read-your-writes — it was just created/updated via dbWrite above) and map it
  // through the SAME `mapAppBlockToListing` the backfill uses, over the exact same
  // projection the backfill selects. That way the two paths cannot drift AND any
  // mod curation already on the row (category/featured/featuredOrder) + the real
  // OauthClient owner are mirrored faithfully — important for the transition case
  // where an app approved BEFORE this feature (possibly already curated) has its
  // first listing minted now on a subsequent-version approve.
  const { mapAppBlockToListing, buildListingScalarSync } = await import('./app-listing-mapper');
  try {
    // (3b-transition) W13 draft-at-submit — an app SUBMITTED after this feature
    // shipped has a pre-approval on-site DRAFT AppListing (kind='onsite',
    // appBlockId=NULL, status='draft', slug=request.slug) minted at submit, carrying
    // any listing media the author set while pending. TRANSITION that draft in place
    // → approved (PRESERVING its icon/cover/screenshots) rather than minting a fresh
    // media-less listing via the mapper. Resolved BY SLUG on the PRIMARY (the
    // `AppBlockPublishRequest` has no appListingId FK; the primary read is
    // read-your-writes-safe + consistent with the (3b-reset) resolve below). If NO
    // draft exists — a request pending BEFORE this shipped (new-submits-only compat,
    // no backfill) or a subsequent-version approve keyed by appBlockId — this no-ops
    // and the UNCHANGED create-or-sync-by-appBlockId path below runs.
    //
    // 🔴 OWNER-SCOPED (`userId: request.submittedByUserId`) — defense-in-depth mirroring
    // the submit-side reuse gate. The transition carries the draft's `userId` forward
    // untouched, so transitioning a draft owned by ANOTHER user would hand them
    // ownership of THIS submitter's approved listing (the listing-media procs gate on
    // `AppListing.userId`). A foreign same-slug draft does NOT match here and falls
    // through to the legacy create path below.
    let handledByDraftTransition = false;
    const draftListing = await dbWrite.appListing.findFirst({
      where: {
        slug: request.slug,
        kind: 'onsite',
        appBlockId: null,
        status: 'draft',
        userId: request.submittedByUserId,
      },
      select: { id: true },
    });
    if (draftListing) {
      // A draft existed → this app's listing is handled here; NEVER fall through to
      // the create branch (that would mint a second, media-less listing).
      handledByDraftTransition = true;
      // Scan-clean go-live gate (same invariant + shared helper as the (3b-reset)
      // restore below and the off-site approve flip): the draft was directly
      // asset-editable while pending, so before making it PUBLICLY visible re-assert
      // its media is `Scanned` (never `Pending`/`Blocked`). A throw here is caught by
      // THIS try (log-and-continue) → the draft stays `draft` (re-review), the app
      // still deploys, and a re-approve after the scan lands transitions it. No-op for
      // scan-clean media. Upholds: no approved listing may reference unscanned/Blocked
      // media.
      const { assertListingAssetsScanCleanInTx, resolveListingRatingFloorInTx } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      await assertListingAssetsScanCleanInTx(dbWrite, draftListing.id);
      const abForTransition = await dbWrite.appBlock.findUnique({
        where: { id: appBlockId },
        select: { blockId: true, manifest: true, category: true, contentRating: true },
      });
      if (abForTransition) {
        // 🔴 RATING FLOOR (go-live). The AppBlock's `contentRating` is MANIFEST-declared
        // (author-controlled), but the author attached the icon/cover/screenshots
        // DIRECTLY to this draft while pending, and the attach path never compares an
        // image's `nsfwLevel` against the listing rating (it rejects only
        // `Blocked`/`NotFound`). Stamping the declared rating verbatim would therefore
        // let mature-but-Scanned media go live on a `g`-rated card and pass
        // `listingMatureFilter(redCapable=false)` to SFW-only users. Raise the declared
        // rating to the media-derived one when the media is more mature (RAISE-ONLY — a
        // deliberately higher declaration is never lowered). Same floor the off-site
        // approve applies via `resolveApprovalContentRating`; upholds the
        // "draft/pending listings are rated at approve" invariant.
        const flooredRating = await resolveListingRatingFloorInTx(
          dbWrite,
          draftListing.id,
          abForTransition.contentRating
        );
        const transitioned = await dbWrite.appListing.updateMany({
          // Status-guarded (draft): a re-approve after a mid-flight failure finds the
          // row already `approved` (0-count, benign) → converges without a duplicate.
          where: { id: draftListing.id, status: 'draft' },
          data: {
            // Link the now-existing AppBlock (was NULL) — first writer satisfies @unique.
            appBlockId,
            status: 'approved',
            // The runtime AppBlock rating (single source of truth — same as the mapper's
            // create path), FLOORED at the rating derived from the media the author
            // attached while pending (raise-only; see the comment above).
            contentRating: flooredRating,
            // Manifest-governed scalars ONLY. iconId/coverId/screenshots, featured,
            // slug are NOT touched, so the author's pending media carries forward.
            ...buildListingScalarSync({
              manifest: abForTransition.manifest,
              blockId: abForTransition.blockId,
              category: abForTransition.category,
            }),
          },
        });
        if (transitioned.count === 0) {
          // eslint-disable-next-line no-console
          console.warn(
            `[approveRequest] draft→approved transition matched 0 rows (slug=${request.slug}, appBlockId=${appBlockId}); ` +
              `the draft may have been concurrently cleaned/approved — re-approve or backfill converges`
          );
        }
      } else {
        // Anomalous (the just-approved AppBlock read null) — leave the draft as-is
        // (recoverable via re-approve / backfill) rather than mint a duplicate.
        // eslint-disable-next-line no-console
        console.warn(
          `[approveRequest] draft→approved transition skipped: AppBlock ${appBlockId} not readable ` +
            `(slug=${request.slug}); the draft stays 'draft' until a re-approve/backfill`
        );
      }
    }

    const existingListing = handledByDraftTransition
      ? null
      : await dbRead.appListing.findUnique({
          where: { appBlockId },
          select: { id: true, kind: true },
        });
    if (handledByDraftTransition) {
      // Already transitioned the pre-approval draft above — nothing more to do.
    } else if (!existingListing) {
      const ab = await dbWrite.appBlock.findUnique({
        where: { id: appBlockId },
        select: {
          id: true,
          blockId: true,
          manifest: true,
          contentRating: true,
          category: true,
          featured: true,
          featuredOrder: true,
          externalUrl: true,
          app: { select: { userId: true } },
        },
      });
      // A resolvable owner is required for the listing's userId FK. Every approved
      // AppBlock has an OauthClient owner, so a miss here is anomalous — skip
      // (don't throw into the already-side-effecting approve flow); the backfill
      // remains the recovery path for such an anomaly.
      if (ab && ab.app && typeof ab.app.userId === 'number') {
        await dbWrite.appListing.create({
          data: mapAppBlockToListing(ab as SourceAppBlock),
          select: { id: true },
        });
      }
    } else {
      // (3b-sync) MANIFEST-GOVERNED COPY RE-SYNC (subsequent-version approve).
      //
      // WHY: an onsite listing's name / tagline / description / category have NO
      // author surface other than the manifest ("ONSITE = ASSETS-ONLY" — the
      // `/apps/[appBlockId]/edit` Listing tab is media-only, and
      // `applyApprovedRevision`'s onsite branch deliberately copies ONLY assets).
      // Before this, those scalars were snapshotted ONCE at the FIRST approve and
      // never refreshed, so a dev who added/edited a description (or the newly
      // manifest-governed tagline) in a later version kept seeing "Missing
      // description" forever and the store kept serving the v1 copy.
      //
      // WHEN: only on a MODERATOR APPROVE — never on a manifest save. A save
      // parks a pending review; the mod is the gate, so store-visible copy never
      // changes without re-review.
      //
      // WHAT WE DO NOT TOUCH (curated / mod-owned): assets (icon / cover /
      // screenshots), `featured` / `featuredOrder`, `contentRating` (mod override,
      // floored at the derived rating), `status`, `slug`, `externalUrl`.
      //
      // `category` comes from `AppBlock.category` — NOT the manifest — because
      // step (3a) writes the manifest category onto that column ONLY when it is
      // still null, so a moderator's curated category (via `setMarketplaceMeta`)
      // survives. Reading the manifest here would silently undo mod curation on
      // every version bump. When the column is null we still write null (the
      // "Missing category" advisory stands, and a mod can curate later).
      //
      // Keyed on `appBlockId`, which is `@unique` and NULL on shadow revision
      // rows — so a live media revision in flight cannot be hit by this write.
      //
      // 🔴 The `kind: 'onsite'` scope is LOAD-BEARING, not decorative: an
      // OFF-SITE listing's name/tagline/description are AUTHOR-supplied through
      // the submit wizard, NOT manifest-governed, so syncing manifest copy onto
      // one would clobber the author's edits. approveRequest only ever produces
      // hosted blocks, so a non-onsite row here is anomalous — but a filter that
      // can silently disable the whole feature must never fail QUIETLY, so we
      // log the skip and the zero-row outcome rather than no-op into the void.
      if (existingListing.kind !== 'onsite') {
        // eslint-disable-next-line no-console
        console.warn(
          `[approveRequest] skipping listing copy re-sync (slug=${request.slug}, appBlockId=${appBlockId}): ` +
            `the backing listing is kind='${existingListing.kind}', whose copy is author-supplied, not manifest-governed`
        );
      } else {
        const ab = await dbWrite.appBlock.findUnique({
          where: { id: appBlockId },
          select: { blockId: true, manifest: true, category: true },
        });
        if (ab) {
          const synced = await dbWrite.appListing.updateMany({
            where: { appBlockId, kind: 'onsite' },
            data: buildListingScalarSync({
              manifest: ab.manifest,
              blockId: ab.blockId,
              category: ab.category,
            }),
          });
          if (synced.count === 0) {
            // The replica said a listing exists but the PRIMARY matched no row —
            // replica lag, or the row changed kind between the two reads. Benign
            // (the next approve converges) but it must be VISIBLE: otherwise the
            // store silently keeps serving the previously-approved copy, which is
            // the exact symptom this re-sync exists to fix.
            // eslint-disable-next-line no-console
            console.warn(
              `[approveRequest] listing copy re-sync matched 0 rows (slug=${request.slug}, appBlockId=${appBlockId}); ` +
                `the store copy stays on the previously-approved version until the next approve`
            );
          }
        }
      }
    }
  } catch (err) {
    // The store listing is a CONVENIENCE — it must NEVER gate the approve/deploy.
    //   - P2002 = unique violation on appBlockId: a concurrent approve/backfill
    //     created the listing first. The invariant (one listing per app) still
    //     holds → silent no-op skip.
    //   - ANY OTHER error (e.g. the app owner deleted their account → user_id FK
    //     violation, an out-of-domain contentRating hitting the CHECK, a transient
    //     DB error): log-and-CONTINUE. If we rethrew, that failure would abort the
    //     whole approve BEFORE the commit/build — and because it re-fails
    //     deterministically, the app could NEVER be re-approved/deployed over a
    //     mere shelf-listing miss. Instead the approve proceeds, the app deploys,
    //     and the listing is simply absent until a `blocks.backfillAppListings`
    //     run mints it. Duck-type on the Prisma error `code` (matches this file's
    //     OauthClient/AppBlock P2002 handling).
    const code = (err as { code?: unknown })?.code;
    if (code !== 'P2002') {
      // eslint-disable-next-line no-console
      console.warn(
        `[approveRequest] onsite AppListing auto-create/copy-sync failed (slug=${request.slug}, appBlockId=${appBlockId}); ` +
          `approve/deploy CONTINUES — the app will not appear on /apps until a blocks.backfillAppListings run, ` +
          `or (for an existing listing) its store copy stays on the previously-approved version until the next approve: ${
            err instanceof Error ? err.message : String(err)
          }`
      );
    }
  }

  // (3b-reset) W13 ONSITE reset-to-pending re-approve — restore BOTH store visibility
  // AND the block runtime. `resetOnsiteListingToPending` (offsite-moderation.service)
  // bounces an approved onsite listing to `pending` AND suspends the backing block
  // (`app_blocks.status` approved → suspended — the real runtime stop), then re-queues
  // THIS request. Re-approving it must therefore undo BOTH halves:
  //   (a) flip the LISTING `pending → approved` so it re-appears on /apps, AND
  //   (b) un-suspend the BLOCK `suspended → approved` so `<slug>.civit.ai` / the run
  //       page serves again.
  // 🔴 (b) is NOT covered by the `appBlock.update` above: the subsequent-version branch
  // (isFirstVersion=false, the reset case — the block already exists) refreshes
  // manifest/version but NEVER sets `status`, so without this the block stays
  // `suspended` while the listing shows `approved` — store-visible but dead, and NOT
  // self-recoverable (`relistListing` guards `status:'removed'`, not `pending`).
  //
  // GATED on the listing having actually been `pending` (the reset case): the guarded
  // listing flip's `count` tells us. Only THEN do we un-suspend the block — so a
  // normal subsequent-version approve of an already-approved app (listing not pending →
  // count 0) does NOT touch the block, and a delisted-then-resubmitted app is never
  // auto-un-suspended here (its listing is `removed`, not `pending`, so count 0 too).
  // Both flips are status-guarded (never clobber a drifted/curated state) — the listing
  // flip touches only `status`. Same log-and-continue posture: the store listing +
  // block restore are a convenience and must NEVER gate the approve/deploy.
  try {
    // 🔴 Scan-clean go-live gate (same invariant + shared helper as the mod/owner
    // republish/relist paths): a reset onsite listing was directly asset-editable while
    // `pending`, so before restoring store visibility (pending → approved) re-read its
    // assets on the PRIMARY and refuse the restore if any is still scanning or was
    // `Blocked`. Throwing here is caught by THIS try (log-and-continue): the app code
    // still deploys — only the store-listing restore is skipped, so the listing stays
    // `pending` (re-review) instead of going live with unscanned/Blocked media. No-op
    // for scan-clean assets. `dbWrite` is passed where the helper expects a tx client
    // (approveRequest is deliberately non-transactional — see the :2326 comment; a
    // PrismaClient is structurally a TransactionClient for these reads).
    const resetListing = await dbWrite.appListing.findFirst({
      where: { appBlockId, kind: 'onsite', status: 'pending' },
      select: { id: true },
    });
    if (resetListing) {
      const { assertListingAssetsScanCleanInTx } = await import(
        '~/server/services/blocks/app-listing-assets.service'
      );
      await assertListingAssetsScanCleanInTx(dbWrite, resetListing.id);
    }
    const restored = await dbWrite.appListing.updateMany({
      where: { appBlockId, kind: 'onsite', status: 'pending' },
      data: { status: 'approved' },
    });
    if (restored.count > 0) {
      // Reset re-approve confirmed → un-suspend the backing block so it serves again.
      // Guarded to `suspended` (idempotent + drift-safe: an already-approved block is
      // a 0-row no-op).
      await dbWrite.appBlock.updateMany({
        where: { id: appBlockId, status: 'suspended' },
        data: { status: 'approved' },
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[approveRequest] onsite reset-to-pending restore failed (slug=${request.slug}, appBlockId=${appBlockId}); ` +
        `approve/deploy CONTINUES — a reset app may stay hidden/suspended until relisted: ${
          err instanceof Error ? err.message : String(err)
        }`
    );
  }

  // (3c) Per-app storage provisioning (W4) — create the app's appsDb schema +
  // tables (kv / quota / shared_kv / votes / counters / shared_kv_reports + the
  // quota triggers + per-app role) at approve, so a storage-declaring app has its
  // datastore the moment it deploys — WITHOUT a manual
  // `/api/admin/apps-storage-backfill` run. Closes the same "approve silently
  // didn't do X" gap as (3a)/(3b): before this, an approved+deployed app that
  // declared `apps:storage:*` had NO schema until someone hand-ran the backfill,
  // so its FIRST storage call 500'd with `relation "app_<slug>.shared_kv" does not
  // exist` (this bit the live `app-requests` app).
  //
  // GATED ON STORAGE SCOPE (design decision): we provision ONLY when the approved
  // manifest declares any `apps:storage:*` scope (per-user read/write OR shared
  // read/write). A gen-only app (e.g. one declaring just `ai:write:budgeted`)
  // never touches the datastore, so minting an empty 6-table schema + role for it
  // is pure litter. An app that ADDS storage in a LATER version is provisioned on
  // THAT version's approve — a scope change requires a new approved version, and
  // the DDL is idempotent, so there is no "added storage but never provisioned"
  // hole. (The admin backfill still provisions ALL approved apps unconditionally;
  // this go-forward path is deliberately narrower.) The scope snapshot used here
  // is the SAME `manifestScopes` written to `AppBlock.approvedScopes` above, so
  // the provision decision matches what the token-mint path will actually grant.
  //
  // IDEMPOTENT: `AppStorageProvisioner.provision` is `CREATE ... IF NOT EXISTS` /
  // DO-block / ON CONFLICT throughout, so first-version and every subsequent-
  // version approve (a re-approve just re-runs the DDL) are equally safe.
  //
  // LOG-AND-CONTINUE (same posture as (3a)/(3b) + #3085/#3089/#3090): storage
  // provisioning must NEVER block an app's approve/deploy. On ANY error we emit a
  // structured warning and CONTINUE — the app still deploys and the schema is
  // recoverable via `/api/admin/apps-storage-backfill`. If we rethrew, a
  // deterministically-failing appsDb (e.g. cnpg-cluster-apps briefly down) would
  // wedge the app's deploy forever over a datastore miss.
  const declaresStorageScope = manifestScopes.some((s) => s.startsWith('apps:storage:'));
  if (declaresStorageScope) {
    // Same slug derivation the backfill uses: sanitizeAppSlug(blockId). request.slug
    // is the manifest blockId (== AppBlock.blockId), already SLUG_REGEX-validated at
    // submit; sanitizeAppSlug folds it to the appsDb schema slug (hyphens → `_`).
    const storageSlug = sanitizeAppSlug(request.slug);
    if (!storageSlug) {
      // Anomalous — a submit-validated blockId should always normalize. Skip +
      // warn rather than throw into the already-side-effecting approve flow.
      // eslint-disable-next-line no-console
      console.warn(
        `[approveRequest] storage provisioning skipped (slug=${request.slug}, appBlockId=${appBlockId}); ` +
          `blockId does not normalize to a valid appsDb slug — recoverable via /api/admin/apps-storage-backfill`
      );
    } else {
      try {
        const { AppStorageProvisioner } = await import(
          '~/server/services/apps/storage-provision.service'
        );
        await AppStorageProvisioner.provision({ appBlockId, slug: storageSlug });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[approveRequest] storage provisioning failed (slug=${request.slug}, appBlockId=${appBlockId}, storageSlug=${storageSlug}); ` +
            `approve/deploy CONTINUES — the app's datastore schema is absent this pass, recoverable via /api/admin/apps-storage-backfill: ${
              err instanceof Error ? err.message : String(err)
            }`
        );
      }
    }
  }

  // (4) Obtain the bundle bytes. Two origins:
  //   - ZIP path (submitVersion): the dev uploaded a ZIP → we have a real
  //     bundleKey → GET it from MinIO (single GET; per-file extract in-memory).
  //   - PUSH path (git-push webhook): a direct push to civitai-apps/<slug> was
  //     parked as a `pending` review request with EMPTY bundle pointers
  //     (bundleKey='') and the pushed forgejoCommitSha — the ZIP was never
  //     uploaded, so the Forgejo repo at that sha IS the artifact. Reconstruct
  //     the bundle from the repo at the exact reviewed sha so everything
  //     downstream (extract / platform-owned filter / manifest rewrite /
  //     screenshots / commit / sha stamp / build trigger) is byte-identical to
  //     the ZIP path. (See git-push.ts recordPendingFromPush.)
  // Platform-owned build files (Dockerfile/nginx.conf) are dropped from the
  // commit — the pipeline injects its own recipe + ignores tenant copies, so
  // committing them to the build-source repo is inert + misleading (audit
  // A8/BUILD-1 Phase 2).
  let bundleBuffer: Buffer;
  if (request.bundleKey) {
    bundleBuffer = await fetchBundleBuffer(request.bundleKey);
  } else if (request.forgejoCommitSha) {
    bundleBuffer = await reconstructBundleFromForgejo(request.slug, request.forgejoCommitSha);
  } else {
    throw new Error(
      `publish request ${request.id} has neither a bundle nor a forgejo commit to approve`
    );
  }
  const files = (await extractBundleFilesFromBuffer(bundleBuffer)).filter(
    (f) => !isPlatformOwnedPath(f.path)
  );

  // Commit the developer's ORIGINAL block.manifest.json with ONLY the
  // platform-owned iframe.src corrected — preserving their field order and NOT
  // injecting server-resolved fields (e.g. trustTier) into the tenant-visible
  // build repo. This keeps civitai-apps/<slug>'s manifest faithful to the upload
  // while its iframe.src agrees with app_blocks.manifest + what the host serves.
  // (The git-push webhook also stamps iframe.src in-memory, and it no-ops on this
  // approved sha BEFORE validating, so this rewrite is for repo fidelity, not
  // validation.) Falls back to the stored manifest only if the bundle's manifest
  // is somehow missing or unparseable (submit requires + parses it, so the
  // fallback is belt-and-suspenders).
  let committedManifestObj: Record<string, unknown> = manifest;
  const originalManifestFile = files.find((f) => f.path === MANIFEST_PATH);
  if (originalManifestFile) {
    try {
      committedManifestObj = JSON.parse(originalManifestFile.content.toString('utf8'));
    } catch {
      committedManifestObj = manifest;
    }
  }
  stampCanonicalIframeSrc(committedManifestObj, request.slug, env.APPS_DOMAIN);
  const canonicalManifestJson = Buffer.from(
    JSON.stringify(committedManifestObj, null, 2) + '\n',
    'utf8'
  );
  let stampedManifestIntoCommit = false;
  const filesForCommit = files.map((f) => {
    if (f.path !== MANIFEST_PATH) return f;
    stampedManifestIntoCommit = true;
    return { ...f, content: canonicalManifestJson };
  });
  if (!stampedManifestIntoCommit) {
    filesForCommit.push({ path: MANIFEST_PATH, content: canonicalManifestJson });
  }

  // (4b) F-E E5 — re-extract + validate the bundle's screenshots (same caps /
  // magic-byte / name gates as submit), then upload them to the bundle MinIO
  // under `screenshots/<appBlockId>/<index>.<ext>`. Persisted to the row in (6).
  // The submit path already rejected a bad bundle, so this re-validation should
  // pass; if a screenshot is somehow invalid here we fail the approve rather
  // than serve unvalidated publisher bytes. Empty bundle dir → [].
  const extractedScreenshots = await extractScreenshots(bundleBuffer);
  const storedScreenshots = await storeScreenshots(appBlockId, extractedScreenshots);

  // (5) Atomic single-commit replacement of the repo contents on
  // civitai-apps/<slug>. This commit fires the git-push webhook.
  const commitMessage = `Approved publish request ${request.id} — ${request.slug} v${request.version}`;
  const { sha: forgejoCommitSha } = await commitFiles({
    slug: request.slug,
    files: filesForCommit,
    message: commitMessage,
    replaceAllFiles: true,
  });

  // (6) Stamp the approved sha onto the app_blocks row and finalise the
  // publish request. These two writes are the durable proof that THIS sha
  // went through moderator review — the git-push webhook keys its
  // no-trust-on-push gate off `current_version_sha` (and, as a race backstop,
  // an `approved` publish request with this `forgejoCommitSha`). Any push
  // whose sha is NOT this approved one is treated as unreviewed and parked in
  // the review queue instead of deploying.
  await dbWrite.appBlock.update({
    where: { id: appBlockId },
    data: {
      currentVersionSha: forgejoCommitSha,
      // F-E E5 — persist the validated, uploaded screenshot records. Replaces
      // the prior set on a re-approve (the storeScreenshots keys are stable per
      // appBlockId+index, so the objects are overwritten in place). An empty
      // gallery is stored as [] so a re-submit that REMOVES all screenshots
      // clears the old set rather than leaving stale entries.
      screenshots: storedScreenshots as object,
    },
  });
  await dbWrite.appBlockPublishRequest.update({
    where: { id: request.id },
    data: {
      status: 'approved',
      reviewedByUserId: params.reviewerUserId,
      reviewedAt: new Date(),
      approvalNotes: params.approvalNotes,
      forgejoCommitSha,
      appBlockId,
    },
  });

  // (6b) Supersede any OTHER request still 'pending' for this slug. If the
  // git-push webhook raced ahead of (6) it may have parked a duplicate
  // pending-review row for THIS approved sha; withdraw it (and any older
  // pending submission) so the queue reflects that the slug is now approved.
  // Scoped to NOT touch the row we just approved.
  await dbWrite.appBlockPublishRequest.updateMany({
    where: { slug: request.slug, status: 'pending', NOT: { id: request.id } },
    data: { status: 'withdrawn' },
  });

  // (7) Trigger the Tekton build directly from the moderator-approve path.
  // This is the ONLY thing that may ship code to a live block — the webhook
  // no longer triggers builds (no-trust-on-push). triggerBuild creates a
  // PipelineRun named after the sha, which Tekton dedups, so a webhook
  // re-delivery cannot double-build.
  const { triggerBuild } = await import('./apps-pipeline.service');
  const { setCommitStatus } = await import('./forgejo.service');
  const callbackUrl = `${(process.env.NEXTAUTH_URL ?? '').replace(
    /\/$/,
    ''
  )}/api/internal/blocks/build-callback`;
  try {
    await setCommitStatus({
      slug: request.slug,
      sha: forgejoCommitSha,
      state: 'pending',
      context: 'civitai/build',
      description: 'Build queued',
    }).catch(() => undefined);
    await triggerBuild({
      slug: request.slug,
      sha: forgejoCommitSha,
      appBlockId,
      callbackUrl,
    });
  } catch (err) {
    await setCommitStatus({
      slug: request.slug,
      sha: forgejoCommitSha,
      state: 'failure',
      context: 'civitai/build',
      description: `Trigger failed: ${String(err).slice(0, 80)}`,
    }).catch(() => undefined);
    throw new Error(
      `approved + committed, but the build trigger failed: ${(err as Error).message}. ` +
        `The new version will NOT deploy until the build is re-triggered (re-approve or re-push).`
    );
  }

  // Phase 2 — surface the build/deploy lifecycle to the developer on
  // /apps/my-submissions. triggerBuild succeeded above (the catch re-throws),
  // so the build is now queued: mark the request 'building'. build-callback
  // advances it deploying → live, or flips it to failed.
  await markRequestDeployState(request.slug, forgejoCommitSha, 'building');

  // MOD REVIEW SANDBOX (#2831) — tear down any review env the mod spun up while
  // reviewing this request. Best-effort + non-blocking: the decision has already
  // landed (status='approved', build triggered), so a teardown failure must
  // never affect the approve outcome. Gated on `hadReviewPreview` (captured from
  // deploy_state BEFORE markRequestDeployState flipped it to production
  // 'building'), so the common no-preview approve does zero extra DB/k8s work.
  if (hadReviewPreview) void teardownReviewForRequest(request.id);
  // AGENTIC REVIEW (P1, audit #1) — tear down any review AGENT UNCONDITIONALLY
  // (an agent can run without a sandbox preview). Idempotent no-op otherwise.
  void teardownAgentReviewForRequest(request.id);

  // POST-COMMIT, best-effort — notify the submitting developer their block was
  // approved (and is now building/deploying). This runs AFTER the status flip to
  // 'approved' + the build trigger have both succeeded (a failed approve throws
  // above and never reaches here → no notification for a rolled-back approve). The
  // whole call is wrapped so a notification failure can NEVER fail or roll back the
  // approve — the decision is already durable. Keyed by the request id for
  // idempotency (a re-approve of the same request notifies once).
  try {
    await notifyAppBlockSubmitter({
      type: 'app-block-approved',
      userId: request.submittedByUserId,
      key: `app-block-approved:${params.publishRequestId}`,
      details: {
        slug: request.slug,
        name: typeof manifest.name === 'string' ? manifest.name : null,
        version: request.version,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[approveRequest] submitter notification failed (id=${params.publishRequestId}); ` +
        `approve stands: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return {
    publishRequestId: request.id,
    appBlockId,
    forgejoCommitSha,
    isFirstVersion,
  };
}

/** Build/deploy lifecycle states surfaced on /apps/my-submissions (Phase 2). */
export type DeployState = 'building' | 'deploying' | 'live' | 'failed';

/**
 * Advisory: stamp the build/deploy lifecycle state onto the APPROVED publish
 * request for `(slug, sha)`. Keyed on `forgejo_commit_sha` (unique per approved
 * version; parked unreviewed requests carry an empty sha so they never match)
 * + `status='approved'`. Best-effort — a status-write failure must never break
 * the approve flow or the build-callback, so errors are swallowed. The build is
 * triggered only by approveRequest, so this is the single source of these
 * transitions: approveRequest sets 'building'; build-callback sets
 * 'deploying'/'live'/'failed'.
 */
export async function markRequestDeployState(
  slug: string,
  sha: string,
  state: DeployState,
  detail?: string | null
): Promise<void> {
  try {
    const { dbWrite } = await import('~/server/db/client');
    const res = await dbWrite.appBlockPublishRequest.updateMany({
      where: { slug, forgejoCommitSha: sha, status: 'approved' },
      data: { deployState: state, deployDetail: detail ?? null, deployUpdatedAt: new Date() },
    });
    if (res.count === 0) {
      // A systemic mis-key would otherwise be invisible (badges silently never
      // advance). Log so a regression is greppable; not fatal.
      // eslint-disable-next-line no-console
      console.warn(
        `[markRequestDeployState] no approved request matched (slug=${slug}, sha=${sha.slice(0, 12)}, state=${state})`
      );
    }
  } catch (err) {
    // deploy_state is advisory display data — never let it break the caller,
    // but don't swallow silently either.
    // eslint-disable-next-line no-console
    console.warn(
      `[markRequestDeployState] write failed (slug=${slug}, state=${state}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// MOD-ONLY BUILD RE-TRIGGER — recover an APPROVED request whose build never ran.
// ---------------------------------------------------------------------------

/**
 * The EXACT `deploy_detail` an app author sees when the moderator's re-trigger
 * could not be handed to the build service.
 *
 * 🔴 FIXED STRING, never derived from the thrown error. `deploy_detail` is
 * owner-visible on both `blocks.listMyPublishRequests` and
 * `GET /api/v1/blocks/submissions`, and the errors `triggerBuild` throws carry
 * infrastructure detail (the trigger receiver's raw response body, the names of
 * the trigger env vars). Those go to the server log instead.
 *
 * It says what the author actually needs: this is our failure, not their code, and
 * they should not resubmit.
 */
export const RETRIGGER_FAILED_AUTHOR_DETAIL =
  'Build re-trigger failed: Civitai could not reach the build service. ' +
  'This is a problem on our side, not with your app — a moderator has to retry it. ' +
  'No new version submission is needed.';

/** Typed failure from {@link retriggerBuild}; `code` drives the tRPC mapping. */
export class RetriggerBuildError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RetriggerBuildError';
    this.code = code;
  }
}

export type RetriggerBuildParams = {
  publishRequestId: string;
  reviewerUserId: number;
};

export type RetriggerBuildResult = {
  publishRequestId: string;
  appBlockId: string;
  forgejoCommitSha: string;
};

/**
 * "APPROVED BUT NOT SUCCESSFULLY BUILT" — the precise, documented definition of a
 * request this function will re-fire a build for:
 *
 *   - `deployState === null`      → the STRANDED case. `approveRequest` made the
 *                                   approval durable (status='approved' +
 *                                   forgejo_commit_sha) and then threw inside
 *                                   `triggerBuild`, so `markRequestDeployState`
 *                                   was never reached. Nothing is building and
 *                                   nothing ever will. 🔴 Allowed ONLY once the
 *                                   approval is older than
 *                                   DEPLOY_PENDING_GRACE_MS — see below.
 *   - `deployState === 'failed'`  → the build or the apply ended badly. Re-firing
 *                                   is exactly the intended recovery (e.g. a
 *                                   transient registry/cluster failure).
 *   - `'building' | 'deploying'`  → allowed ONLY once `deployUpdatedAt` is older
 *                                   than DEPLOY_STALE_AFTER_MS, i.e. the same
 *                                   "stalled" threshold the owner-facing UI uses.
 *                                   A genuinely in-flight build is NEVER
 *                                   re-fired — that would race two PipelineRuns.
 *
 * Everything else is refused: `'live'` (already deployed — a rebuild would churn
 * a serving app for no reason) and any `preview-*` value (the mod review-sandbox
 * lane, which has its own build/teardown path and must not be driven from here).
 *
 * 🔴 WHY THE NULL BRANCH IS TIME-BOUNDED. `approveRequest` writes the approval,
 * then `await`s `triggerBuild` (up to a 30s network timeout), and only THEN writes
 * `deploy_state='building'`. In that window the row legitimately reads null on the
 * PRIMARY while a PipelineRun is already being created — reading the primary
 * (which this function's caller now does) cannot close it, because the gap is in
 * WALL TIME, not replica lag. An unbounded null branch therefore let a second
 * moderator race a second PipelineRun onto the same sha. The bound is
 * DEPLOY_PENDING_GRACE_MS — the SHARED constant the owner UI already uses for
 * exactly this approve→mark window, and comfortably above triggerBuild's own
 * timeout. It is deliberately NOT DEPLOY_STALE_AFTER_MS: making a moderator wait
 * 45 minutes to recover a request that is already provably stranded would defeat
 * the recovery this whole procedure exists to provide.
 *
 * With NO anchor at all (`reviewedAt` and `deployUpdatedAt` both null) the window
 * cannot be measured, so the null branch FAILS CLOSED — matching the in-flight
 * branch's "no timestamp → refuse". `approveRequest` always stamps `reviewedAt`,
 * so a real approved row always has an anchor.
 */
function assertRetriggerableDeployState(
  deployState: string | null,
  deployUpdatedAt: Date | null,
  reviewedAt: Date | null,
  now: number
): void {
  if (deployState === null) {
    // Anchor: the approval time (the null case has no transition by definition;
    // deployUpdatedAt is only a fallback for an odd null-state-with-transition row).
    const anchor = reviewedAt?.getTime() ?? deployUpdatedAt?.getTime() ?? null;
    if (anchor == null || now - anchor <= DEPLOY_PENDING_GRACE_MS) {
      throw new RetriggerBuildError(
        'NOT_RETRIGGERABLE',
        'This request was just approved — its first build may still be starting. Wait a moment and retry.'
      );
    }
    return; // stranded — the whole point
  }
  if (deployState === 'failed') return;
  if (deployState === 'live') {
    throw new RetriggerBuildError(
      'NOT_RETRIGGERABLE',
      'This version is already deployed. Submit a new version instead of rebuilding a live one.'
    );
  }
  if (deployState.startsWith('preview-')) {
    throw new RetriggerBuildError(
      'NOT_RETRIGGERABLE',
      `Request is in the review-preview lane (${deployState}); use the review preview controls.`
    );
  }
  if (deployState === 'building' || deployState === 'deploying') {
    const updated = deployUpdatedAt ? deployUpdatedAt.getTime() : null;
    if (updated == null || now - updated <= DEPLOY_STALE_AFTER_MS) {
      throw new RetriggerBuildError(
        'NOT_RETRIGGERABLE',
        `A build is already ${deployState}. Wait for it to finish or stall before re-triggering.`
      );
    }
    return; // stalled past the shared threshold → recovery is legitimate
  }
  throw new RetriggerBuildError(
    'NOT_RETRIGGERABLE',
    `Unexpected deploy state "${deployState}"; not re-triggering.`
  );
}

/**
 * Re-fire the Tekton build for an ALREADY-APPROVED publish request, using the sha
 * that was already committed and reviewed.
 *
 * WHY THIS EXISTS — `approveRequest` is not idempotent (`cannot approve a request
 * in status approved`) and there was no other way to re-run a build, so an
 * approved request whose `triggerBuild` threw was UNRECOVERABLE: the only fix was
 * for the developer to resubmit at a brand-new version number. This is that
 * missing recovery, and nothing more.
 *
 * DELIBERATELY NONE OF `approveRequest`'S SIDE EFFECTS: no Forgejo commit, no
 * AppBlock / OauthClient mutation, no listing / category / storage provisioning,
 * no approval notification, no supersede-others sweep. It re-runs step (7) of the
 * approve flow and only step (7).
 *
 * MODERATION IS NOT BYPASSED. The sha comes from the DB row a moderator already
 * approved; the caller cannot name a sha (see `retriggerBuildSchema`), and the
 * supersede guard below refuses even the stored sha once a NEWER version has been
 * approved for the app.
 */
export async function retriggerBuild(
  params: RetriggerBuildParams
): Promise<RetriggerBuildResult> {
  const [{ dbWrite }, { env }] = await Promise.all([
    import('~/server/db/client'),
    import('~/env/server'),
  ]);

  // (1) The request must exist.
  //
  // 🔴 READ THE PRIMARY (`dbWrite`), NOT the replica. Every value below is a
  // GUARD, and `dbRead` is a separate readonly client that can lag. Concretely:
  // a moderator approves v2 (primary now has AppBlock.currentVersionSha = B) and
  // within the lag window another moderator hits "Retrigger" on v1 — a replica
  // still serving currentVersionSha = A lets the supersede guard (5) pass, and
  // v1's older reviewed sha gets rebuilt and deployed OVER the newer approval.
  // The same lag re-opens the deploy-state gate (6): a fresh `deploy_state =
  // 'building'` can read back as null, so a second PipelineRun races the first.
  // The redis NX lock does not help — `approveRequest` never takes it. This is a
  // once-per-click moderator action, so the primary read costs nothing.
  const request = await dbWrite.appBlockPublishRequest.findUnique({
    where: { id: params.publishRequestId },
    select: {
      id: true,
      status: true,
      slug: true,
      appBlockId: true,
      forgejoCommitSha: true,
      deployState: true,
      deployUpdatedAt: true,
      // Anchor for the null-deploy-state grace window (see
      // assertRetriggerableDeployState).
      reviewedAt: true,
      appBlock: { select: { id: true, currentVersionSha: true } },
    },
  });
  if (!request) {
    throw new RetriggerBuildError(
      'NOT_FOUND',
      `publish request ${params.publishRequestId} not found`
    );
  }

  // (2) Only an APPROVED request has a reviewed, committed sha to rebuild.
  if (request.status !== 'approved') {
    throw new RetriggerBuildError(
      'NOT_RETRIGGERABLE',
      `cannot re-trigger a build for a request in status ${request.status}`
    );
  }

  // (3) The sha comes from the DB and must look like a real commit. The procedure
  //     input carries no sha at all, so there is nothing to smuggle in here — this
  //     is the integrity check on our OWN stored value, not input validation.
  //
  //     🔴 DISTINCT ERROR CODE, deliberately. Sharing NOT_RETRIGGERABLE with the
  //     supersede guard (5) made this guard untestable: the stranded fixture also
  //     trips (5), so a test asserting "malformed sha is refused" passed even with
  //     this check deleted. A code only this guard can produce makes the assertion
  //     load-bearing (see the mutation note in the retriggerBuild test suite).
  const sha = request.forgejoCommitSha;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new RetriggerBuildError(
      'INVALID_STORED_SHA',
      'Request has no valid committed sha to rebuild.'
    );
  }

  // (4) An approved request always has a backing block; without it there is
  //     nothing to build an image for.
  const appBlockId = request.appBlockId;
  if (!appBlockId) {
    throw new RetriggerBuildError('NOT_RETRIGGERABLE', 'Request has no backing app block.');
  }

  // (5) SUPERSEDED — a newer version has been approved for this app since. The
  //     app's current sha is what should be serving; rebuilding + deploying this
  //     OLDER sha would roll the live app backwards. Refuse.
  const currentSha = request.appBlock?.currentVersionSha ?? null;
  if (currentSha && currentSha !== sha) {
    throw new RetriggerBuildError(
      'NOT_RETRIGGERABLE',
      'A newer version has since been approved for this app — re-triggering this older version would deploy stale code.'
    );
  }

  // (6) Deploy-state gate (see assertRetriggerableDeployState for the definition).
  assertRetriggerableDeployState(
    request.deployState,
    request.deployUpdatedAt,
    request.reviewedAt,
    Date.now()
  );

  if (!env.FORGEJO_BASE_URL || !env.FORGEJO_ADMIN_TOKEN) {
    throw new RetriggerBuildError('NOT_RETRIGGERABLE', 'Forgejo not configured');
  }

  // (7) Abuse controls — redis-backed, because the tRPC `rateLimit` middleware
  //     short-circuits for moderators and would be a no-op here.
  const { acquireRetriggerLock, releaseRetriggerLock, checkRetriggerModeratorQuota } = await import(
    '~/server/utils/blocks-retrigger-rate-limit'
  );
  const quota = await checkRetriggerModeratorQuota(params.reviewerUserId);
  if (!quota.allowed) {
    throw new RetriggerBuildError(
      'RATE_LIMITED',
      `Too many build re-triggers — try again in ${quota.retryAfterSeconds}s.`
    );
  }
  // Single-flight: a double-click must not create two PipelineRuns.
  if (!(await acquireRetriggerLock(request.id))) {
    throw new RetriggerBuildError(
      'RATE_LIMITED',
      'A re-trigger for this request is already in flight.'
    );
  }

  // (8) Fire it — the same step (7) `approveRequest` runs, nothing else.
  const { triggerBuild } = await import('./apps-pipeline.service');
  const { setCommitStatus } = await import('./forgejo.service');
  const callbackUrl = `${(process.env.NEXTAUTH_URL ?? '').replace(
    /\/$/,
    ''
  )}/api/internal/blocks/build-callback`;

  await setCommitStatus({
    slug: request.slug,
    sha,
    state: 'pending',
    context: 'civitai/build',
    description: 'Build re-queued by a moderator',
  }).catch(() => undefined);

  try {
    await triggerBuild({ slug: request.slug, sha, appBlockId, callbackUrl });
  } catch (err) {
    // Free the single-flight slot so the moderator can retry immediately rather
    // than waiting out the TTL after a visible failure.
    await releaseRetriggerLock(request.id);
    const internalDetail = err instanceof Error ? err.message : String(err);
    // 🔴 The INTERNAL detail goes to the server log ONLY. `triggerBuild` throws
    // `trigger <status> <statusText>: <first 240 bytes of the receiver's response
    // body>`, or a message naming the trigger env vars — infrastructure detail
    // that must never reach a third-party app author.
    void import('~/server/logging/client')
      .then(({ logToAxiom }) =>
        logToAxiom(
          {
            type: 'error',
            name: 'app-block-retrigger-failed',
            message: 'retriggerBuild: the build trigger call failed',
            details: {
              publishRequestId: request.id,
              slug: request.slug,
              appBlockId,
              reviewerUserId: params.reviewerUserId,
              error: internalDetail,
            },
          },
          'app-blocks'
        )
      )
      .catch(() => undefined);
    await setCommitStatus({
      slug: request.slug,
      sha,
      state: 'failure',
      context: 'civitai/build',
      // The author can see their own repo's commit statuses, so this stays
      // generic too — the detail is in the server log above.
      description: 'Build re-trigger failed; see Civitai for details',
    }).catch(() => undefined);
    // 🔴 Make the failure VISIBLE — this is the half of the fix that matters most:
    // a stranded request's whole problem is that it looks healthy while nothing is
    // happening. Even when the retrigger ITSELF fails, the row now carries a
    // 'failed' state + a reason instead of reverting to a silent null.
    //
    // 🔴 …but the reason stored here is OWNER-VISIBLE (`deploy_detail` is returned
    // by BOTH `blocks.listMyPublishRequests` and GET /api/v1/blocks/submissions),
    // so it is a FIXED, GENERIC, author-actionable string — never the thrown
    // error. It still goes through `sanitizeBuildFailureReason` so the stored
    // value keeps that module's "guaranteed printable, bounded text" invariant on
    // every write path, not just the build-callback one.
    await markRequestDeployState(
      request.slug,
      sha,
      'failed',
      sanitizeBuildFailureReason(RETRIGGER_FAILED_AUTHOR_DETAIL) ?? null
    );
    throw new RetriggerBuildError(
      'TRIGGER_FAILED',
      // Moderator-facing (a `moderatorProcedure` response), and deliberately also
      // generic: the actionable internal detail is in the server log, keyed by the
      // publish-request id above.
      'The build re-trigger could not be sent to the build service. The request is now marked failed; try again once the build service is reachable.'
    );
  }

  // Build is queued — advance the lifecycle exactly as approveRequest does, with
  // an attributable detail so the mod queue shows who re-fired it and when.
  await markRequestDeployState(
    request.slug,
    sha,
    'building',
    `Build re-triggered by moderator #${params.reviewerUserId} at ${new Date().toISOString()}`
  );

  return { publishRequestId: request.id, appBlockId, forgejoCommitSha: sha };
}

// ---------------------------------------------------------------------------
// MOD REVIEW SANDBOX (#2831) — run a PENDING version in a temporary, mod-gated
// preview before approving.
//
// State is stored on the PENDING request's deploy_state / deploy_detail columns
// (which markRequestDeployState only ever writes for APPROVED rows, so there's
// no collision): deploy_state carries a `preview-*` lifecycle value and
// deploy_detail carries a JSON `ReviewPreviewDetail` blob with the review sha +
// URL + last error. No schema migration — the columns already exist + are
// nullable, and a pending request never uses them otherwise.
// ---------------------------------------------------------------------------

/** Preview lifecycle states (PENDING request's deploy_state). Distinct prefix
 *  from the production DeployState values so the two never collide. */
export type ReviewPreviewState =
  | 'preview-building'
  | 'preview-deploying'
  | 'preview-live'
  | 'preview-failed';

/**
 * Global cap on concurrently-active review previews across ALL moderators. Each
 * active preview holds a review Deployment + Service + IngressRoute in the apps
 * namespace, so this bounds the review sandbox's cluster footprint.
 */
export const MAX_CONCURRENT_REVIEW_PREVIEWS = 5;

/**
 * Active-preview TTL window (ms). Mirrors the `review-sandbox-janitor` CronJob's
 * 6h reap TTL: a preview the janitor has already deleted in k8s — but whose DB
 * row still reads `preview-live`, because the janitor can't write the civitai DB
 * — naturally ages OUT of the active count once its `deployUpdatedAt` is older
 * than this. No k8s call and no janitor coupling needed.
 */
export const REVIEW_PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;

/** deploy_state values that count as an ACTIVE review preview. Excludes
 *  `preview-failed` (dead) and `null` (never started). */
const ACTIVE_REVIEW_PREVIEW_STATES: ReviewPreviewState[] = [
  'preview-building',
  'preview-deploying',
  'preview-live',
];

type ActiveReviewPreviewRow = {
  id: string;
  slug: string;
  version: string;
  deployState: string | null;
  deployDetail: string | null;
  deployUpdatedAt: Date | null;
};

/**
 * Fetch the currently-active review-preview rows, oldest-first. The predicate —
 * `status='pending'` AND `deployState IN (building|deploying|live)` AND
 * `deployUpdatedAt > now() - REVIEW_PREVIEW_TTL_MS` — is the SINGLE source of
 * truth shared by the concurrency-cap count and the listActivePreviews query.
 * The `status='pending'` + `preview-` prefix filter is load-bearing: deploy_state
 * is SHARED with the production build lifecycle, so an approved row's `building`/
 * `live` value must never be counted here.
 */
async function findActiveReviewPreviewRows(opts?: {
  excludePublishRequestId?: string;
}): Promise<ActiveReviewPreviewRow[]> {
  const { dbRead } = await import('~/server/db/client');
  const cutoff = new Date(Date.now() - REVIEW_PREVIEW_TTL_MS);
  return dbRead.appBlockPublishRequest.findMany({
    where: {
      status: 'pending',
      deployState: { in: ACTIVE_REVIEW_PREVIEW_STATES },
      deployUpdatedAt: { gt: cutoff },
      ...(opts?.excludePublishRequestId ? { id: { not: opts.excludePublishRequestId } } : {}),
    },
    orderBy: { deployUpdatedAt: 'asc' }, // oldest first — the natural teardown-candidate order
    select: {
      id: true,
      slug: true,
      version: true,
      deployState: true,
      deployDetail: true,
      deployUpdatedAt: true,
    },
  });
}

/**
 * Count active review previews (see {@link findActiveReviewPreviewRows} for the
 * predicate). Global across all mods; drives the concurrency cap. Pass
 * `excludePublishRequestId` to omit a specific request (so a REBUILD of an
 * already-active preview never counts itself against the cap).
 */
export async function countActiveReviewPreviews(opts?: {
  excludePublishRequestId?: string;
}): Promise<number> {
  const rows = await findActiveReviewPreviewRows(opts);
  return rows.length;
}

export type ActiveReviewPreview = {
  publishRequestId: string;
  slug: string;
  version: string;
  state: ReviewPreviewState;
  host: string | null;
  updatedAt: Date | null;
};

/**
 * List the currently-active review previews (same predicate as the cap count),
 * oldest-first, for the global "Active previews (N / cap)" mod panel. Does NOT
 * mint mr access tokens — per-row token minting on a list poll is wasteful;
 * opening a live preview stays in the per-request panel via getReviewStatus.
 */
export async function listActiveReviewPreviews(): Promise<{
  cap: number;
  active: ActiveReviewPreview[];
}> {
  const rows = await findActiveReviewPreviewRows();
  return {
    cap: MAX_CONCURRENT_REVIEW_PREVIEWS,
    active: rows.map((r) => ({
      publishRequestId: r.id,
      slug: r.slug,
      version: r.version,
      state: r.deployState as ReviewPreviewState,
      host: parseReviewDetail(r.deployDetail).host ?? null,
      updatedAt: r.deployUpdatedAt ?? null,
    })),
  };
}

export type ReviewPreviewDetail = {
  /** Full review build sha (in-review repo HEAD). */
  sha?: string;
  /** review-<sha[:16]>.<APPS_DOMAIN> host the preview serves at. */
  host?: string;
  /** Full https URL to embed (`https://<host>/<slug>`). */
  url?: string;
  /** Human-readable failure detail when state is preview-failed. */
  error?: string;
  /** Mod who started the preview (audit). */
  modUserId?: number;
};

/** Pack a ReviewPreviewDetail into the deploy_detail string column. */
function packReviewDetail(detail: ReviewPreviewDetail): string {
  return JSON.stringify(detail);
}

/** Parse a deploy_detail string back into a ReviewPreviewDetail (tolerant of a
 *  legacy plain-string detail — returns {} so polling degrades gracefully). */
export function parseReviewDetail(raw: string | null | undefined): ReviewPreviewDetail {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as ReviewPreviewDetail) : {};
  } catch {
    return {};
  }
}

/**
 * Stamp the review-preview lifecycle state onto the PENDING request. Keyed on
 * `{ id, status:'pending' }` so it can never write a non-pending row. Best-effort
 * (a status write must not break the preview/approve flow) but logged on miss.
 *
 * Pass `requireActivePreview` for the transitions driven by the async build
 * callback / apply watcher (deploying → live / failed): it additionally requires
 * the row's `deployState` to still be a `preview-*` value, so a preview a mod
 * TORE DOWN mid-build (teardownPreview clears deployState to null but leaves
 * status='pending') is NOT resurrected by a late callback write. The initial
 * `preview-building` mark from previewRequest must NOT set this (it transitions
 * from null / preview-failed → preview-building).
 *
 * Pass `expectedSha` for a stale-watcher guard on the apply watcher's advancing
 * writes. `requireActivePreview` proves *some* preview is active, but is sha-
 * BLIND — it can't tell whether the active preview is the one THIS watcher owns.
 * Because the reachability wait keeps a watcher alive for up to a few minutes, a
 * mod can tear down preview A mid-wait and re-preview (build B) within that
 * window; without a sha check, watcher A's late live/failed write matches B's
 * active row and clobbers it (marking a live B failed, or — worse — stamping B
 * `preview-live` with A's host/url so the mod reviews the WRONG code). When set,
 * the write additionally requires the row's CURRENT `deployDetail` to still
 * carry this build's sha, so a superseded watcher's write affects 0 rows.
 * `deployDetail` is a stringified-JSON `String` column (not a Prisma `Json`
 * column), so this matches the serialized `"sha":"<sha>"` fragment via
 * `contains` — a single atomic UPDATE…WHERE, no read-then-write race. The sha is
 * a 40-char hex the callback validates against /^[0-9a-f]{40}$/, so it's a safe,
 * collision-free literal to embed. Only the WATCHER's advancing writes pass this;
 * the initial `previewRequest`/`preview-building` write must NOT (it is
 * establishing the new preview, whose sha isn't yet on the row).
 */
export async function markReviewPreviewState(
  publishRequestId: string,
  state: ReviewPreviewState,
  detail: ReviewPreviewDetail,
  opts?: { requireActivePreview?: boolean; expectedSha?: string }
): Promise<void> {
  try {
    const { dbWrite } = await import('~/server/db/client');
    const res = await dbWrite.appBlockPublishRequest.updateMany({
      where: {
        id: publishRequestId,
        status: 'pending',
        // Only advance a row that is STILL an active preview (torn-down rows have
        // deployState=null → excluded → no resurrection).
        ...(opts?.requireActivePreview ? { deployState: { startsWith: 'preview-' } } : {}),
        // Stale-watcher guard: only advance if the row's current detail still
        // belongs to this build's sha (the serialized `"sha":"<sha>"` fragment).
        ...(opts?.expectedSha
          ? { deployDetail: { contains: `"sha":"${opts.expectedSha}"` } }
          : {}),
      },
      data: {
        deployState: state,
        deployDetail: packReviewDetail(detail),
        deployUpdatedAt: new Date(),
      },
    });
    if (res.count === 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[markReviewPreviewState] no pending request matched (id=${publishRequestId}, state=${state})`
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[markReviewPreviewState] write failed (id=${publishRequestId}, state=${state}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

export type PreviewRequestParams = {
  publishRequestId: string;
  modUserId: number;
};

export type PreviewRequestResult = {
  publishRequestId: string;
  slug: string;
  sha: string;
  host: string;
  url: string;
  pipelineRun: string;
};

/**
 * Start a review preview for a PENDING publish request. Reads the in-review repo
 * HEAD (the pending bundle's source), triggers a REVIEW build (separate image +
 * host from production), stamps state `preview-building`, and returns the review
 * URL the UI polls toward. The build-callback (review-build-callback) advances
 * deploying → live, or flips to failed.
 *
 * Throws (BAD_REQUEST upstream) if the request isn't pending or the trigger
 * fails — the router maps it. The whole feature is dark behind the mod-only
 * review-sandbox flag (gated in the router), so this never runs in prod until
 * enabled.
 */
export async function previewRequest(
  params: PreviewRequestParams
): Promise<PreviewRequestResult> {
  const [{ dbRead }, { env }] = await Promise.all([
    import('~/server/db/client'),
    import('~/env/server'),
  ]);
  const { getReviewRepoHeadSha } = await import('./forgejo.service');
  const { triggerReviewBuild, reviewHost } = await import('./apps-pipeline.service');

  const request = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: params.publishRequestId },
    select: { id: true, status: true, slug: true },
  });
  if (!request) throw new Error(`publish request ${params.publishRequestId} not found`);
  if (request.status !== 'pending') {
    throw new Error(`can only preview a pending request (status is ${request.status})`);
  }

  // Global concurrent-preview cap. Count OTHER active previews (exclude THIS
  // request) so a REBUILD of an already-active preview is never blocked, and a
  // fresh request is blocked only when MAX others are already active. SOFT cap:
  // two simultaneous clicks can both pass the count and land at cap+1 — accepted
  // (no DB lock), same fail-open posture as the block-catalog checkpoint cache
  // rate limit (checkpoint.service). One extra review env is harmless.
  const activeOthers = await findActiveReviewPreviewRows({
    excludePublishRequestId: request.id,
  });
  if (activeOthers.length >= MAX_CONCURRENT_REVIEW_PREVIEWS) {
    const slugs = activeOthers.slice(0, 8).map((r) => r.slug);
    const more =
      activeOthers.length > slugs.length ? `, +${activeOthers.length - slugs.length} more` : '';
    throw new Error(
      `Review preview cap reached (${activeOthers.length}/${MAX_CONCURRENT_REVIEW_PREVIEWS} active): ${slugs.join(
        ', '
      )}${more}. Tear down a preview to free a slot.`
    );
  }

  // The in-review repo HEAD is the pending bundle's source (submitVersion pushed
  // it there; one pending per slug). Build clones + tags at this sha.
  const sha = await getReviewRepoHeadSha(request.slug);
  const host = reviewHost(sha, env.APPS_DOMAIN);
  const url = `https://${host}/${request.slug}`;

  const callbackUrl = `${(process.env.NEXTAUTH_URL ?? '').replace(
    /\/$/,
    ''
  )}/api/internal/blocks/review-build-callback`;

  // Mark building BEFORE the trigger so the UI sees state immediately even if the
  // trigger response is slow; a trigger failure flips it back to failed below.
  await markReviewPreviewState(request.id, 'preview-building', {
    sha,
    host,
    url,
    modUserId: params.modUserId,
  });

  let run: { name: string };
  try {
    run = await triggerReviewBuild({
      slug: request.slug,
      sha,
      publishRequestId: request.id,
      modUserId: params.modUserId,
      callbackUrl,
    });
  } catch (err) {
    await markReviewPreviewState(request.id, 'preview-failed', {
      sha,
      host,
      url,
      modUserId: params.modUserId,
      error: `review build trigger failed: ${(err as Error).message}`.slice(0, 240),
    });
    throw new Error(`could not start review build: ${(err as Error).message}`);
  }

  return {
    publishRequestId: request.id,
    slug: request.slug,
    sha,
    host,
    url,
    pipelineRun: run.name,
  };
}

export type ReviewStatusResult = {
  publishRequestId: string;
  status: string;
  state: ReviewPreviewState | null;
  detail: ReviewPreviewDetail;
  updatedAt: Date | null;
  /**
   * A FRESH, mod-bound, short-TTL tokened URL to embed in the review iframe,
   * present ONLY when the preview is live AND a calling mod id was supplied.
   * `https://<host>/<slug>?mr=<token>`. The parent re-reads this on every poll,
   * so the live iframe never serves a stale (expired) token. The token is the
   * cross-origin access bridge — the `*.civit.ai` mod-gate forwardAuth verifies
   * it on the entry document request (no cross-domain cookie).
   */
  previewUrl?: string;
};

/**
 * Poll target for the mod-review UI: returns the current preview lifecycle state
 * + detail (sha / host / url / error) for a publish request. Reads the same
 * deploy_state / deploy_detail columns previewRequest + the review-build-callback
 * write. Returns `state:null` when no preview has been started.
 *
 * When `modUserId` is supplied (server-derived from the calling moderator) AND
 * the preview is live with a known host/url, mints a fresh mod-bound access
 * token and returns `previewUrl` = `<detail.url>?mr=<token>`. The token is bound
 * to THIS mod's id + the review host and expires in ~120s, so the parent must
 * read it fresh on each poll (which the UI does). The mint is gated by the
 * router (moderatorProcedure + enforceAppBlocksFlag + the review-sandbox flag),
 * so an unauthenticated / non-mod / flag-off caller never reaches here.
 */
export async function getReviewStatus(opts: {
  publishRequestId: string;
  /** Calling moderator's id — bind the minted preview token to it. Omit to skip
   *  minting (e.g. a non-mod-gated read, which the router does not expose). */
  modUserId?: number;
}): Promise<ReviewStatusResult> {
  const { dbRead } = await import('~/server/db/client');
  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: opts.publishRequestId },
    select: { id: true, status: true, deployState: true, deployDetail: true, deployUpdatedAt: true },
  });
  if (!row) throw new Error(`publish request ${opts.publishRequestId} not found`);
  const isPreviewState =
    typeof row.deployState === 'string' && row.deployState.startsWith('preview-');
  const state = isPreviewState ? (row.deployState as ReviewPreviewState) : null;
  const detail = isPreviewState ? parseReviewDetail(row.deployDetail) : {};

  let previewUrl: string | undefined;
  if (state === 'preview-live' && opts.modUserId != null && detail.host && detail.url) {
    const { signReviewAccessToken } = await import('./review-session');
    const token = signReviewAccessToken({ modUserId: opts.modUserId, host: detail.host });
    const sep = detail.url.includes('?') ? '&' : '?';
    previewUrl = `${detail.url}${sep}mr=${encodeURIComponent(token)}`;
  }

  return {
    publishRequestId: row.id,
    status: row.status,
    state,
    detail,
    updatedAt: row.deployUpdatedAt ?? null,
    previewUrl,
  };
}

/**
 * MOD REVIEW SANDBOX (#2831) — resolve the target for a full-page review preview
 * mount (`/apps/review/preview/<publishRequestId>`).
 *
 * The page needs the `slug` to drive `ReviewBlockPreviewHost`, but the shared
 * `getReviewStatus` return shape deliberately does NOT carry it (that shape feeds
 * the modal poll and is kept minimal). This resolves the row by id server-side in
 * the page's `getServerSideProps` instead of widening `getReviewStatus`.
 *
 * Returns `{ id, slug }` ONLY for an EXISTING, PENDING request — the only state a
 * review preview can ever be live against (teardown clears the preview on
 * approve/reject, matching `mintReviewBlockToken`'s pending gate). Returns null
 * for a missing / non-pending request so the page fails closed with a 404 and
 * never leaks which of the two it was.
 *
 * NO AUTHORIZATION is performed here (like `getReviewStatus` / `mintReviewBlockToken`,
 * which rely on their router gate) — this leaks a pending app's slug by id, so
 * EVERY caller MUST already be moderator-gated (today: the page resolver runs the
 * `isAppReviewer` gate before calling). Do not call from a non-mod-gated path.
 */
export async function resolveReviewPreviewTarget(
  publishRequestId: string
): Promise<{ id: string; slug: string } | null> {
  const { dbRead } = await import('~/server/db/client');
  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { id: true, status: true, slug: true },
  });
  if (!row) return null;
  if (row.status !== 'pending') return null;
  return { id: row.id, slug: row.slug };
}

/** The review-page modes a single request can be opened in. Mirrors the modal's
 *  `mode` union minus `reports` (reports are off-site listings, not publish
 *  requests). A row in any OTHER status (`withdrawn`, superseded) is not a
 *  reviewable detail and resolves to `null`. */
export type ReviewRequestMode = 'pending' | 'approved' | 'rejected';

function reviewModeForStatus(status: string): ReviewRequestMode | null {
  if (status === 'pending') return 'pending';
  if (status === 'approved') return 'approved';
  if (status === 'rejected') return 'rejected';
  return null;
}

/**
 * SSR fail-close resolver for the per-submission review PAGE
 * (`/apps/review/<publishRequestId>`) — the page analogue of
 * {@link resolveReviewPreviewTarget}, but valid for pending/approved/rejected
 * (the page shows history too, not only the live-preview-able pending state).
 *
 * Returns `{ id, status }` ONLY for an existing request in a reviewable status;
 * `null` for a missing / withdrawn / superseded row so the page's
 * `getServerSideProps` 404s without leaking which. Cheap (id+status only) so the
 * SSR gate stays light; the full request payload is fetched client-side via
 * {@link getReviewRequestById} (keeps the big manifest/diff blobs off the SSR
 * props, and Dates on the tRPC/superjson path instead of hand-serialized).
 *
 * NO AUTHORIZATION here (like `resolveReviewPreviewTarget`) — leaks a slug/status
 * by id, so EVERY caller MUST already be moderator-gated (the page resolver runs
 * `isAppReviewer` before calling).
 */
export async function resolveReviewRequestTarget(
  publishRequestId: string
): Promise<{ id: string; status: ReviewRequestMode } | null> {
  const { dbRead } = await import('~/server/db/client');
  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { id: true, status: true },
  });
  if (!row) return null;
  const mode = reviewModeForStatus(row.status);
  if (!mode) return null;
  return { id: row.id, status: mode };
}

/**
 * Single-request fetch for the review PAGE. Returns the SAME hydrated shape one
 * item of `listPending/Approved/RejectedRequests` returns (so the extracted
 * `OnsiteReviewModalBody` renders identically to the modal path), plus the
 * derived `mode`. Includes the reviewer profile + approval-notes / rejection-
 * reason so an approved/rejected detail shows the same read-only history the
 * list tabs surface. Returns `null` for a missing / non-reviewable row.
 *
 * MOD-ONLY: like the list builders it performs no authorization — the router
 * (`moderatorProcedure` + `enforceAppBlocksFlag`) gates it.
 */
export async function getReviewRequestById(publishRequestId: string): Promise<{
  mode: ReviewRequestMode;
  request: Record<string, unknown>;
} | null> {
  const [{ dbRead }, { reviewRepoUrl, repoCommitUrl }] = await Promise.all([
    import('~/server/db/client'),
    import('./forgejo.service'),
  ]);
  const r = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: {
      id: true,
      appBlockId: true,
      slug: true,
      version: true,
      status: true,
      submittedAt: true,
      reviewedAt: true,
      approvalNotes: true,
      rejectionReason: true,
      bundleSizeBytes: true,
      bundleSha256: true,
      manifest: true,
      fileSummary: true,
      manifestDiffSummary: true,
      forgejoCommitSha: true,
      submittedBy: { select: { id: true, username: true, image: true } },
      reviewedBy: { select: { id: true, username: true, image: true } },
    },
  });
  if (!r) return null;
  const mode = reviewModeForStatus(r.status);
  if (!mode) return null;

  // Match the list builders' row mapping exactly (bundle bigint → string,
  // Forgejo review-repo deep link, push-row canonical-commit link).
  const { status, ...rest } = r;
  const request = {
    ...rest,
    bundleSizeBytes: r.bundleSizeBytes.toString(),
    reviewRepoUrl: reviewRepoUrl(r.slug),
    pushCommitUrl:
      !r.bundleSha256 && r.forgejoCommitSha
        ? repoCommitUrl(r.slug, r.forgejoCommitSha)
        : null,
  };
  return { mode, request };
}

export type MintReviewBlockTokenResult = {
  /** The signed, self-bound, scope-stripped block JWT for the review preview. */
  token: string;
  expiresAt: string;
  /** The scopes that SURVIVED the render-only clamp (the block's real capability). */
  scopes: string[];
  /** Forced-SFW: the review mint never reads a color domain. */
  domain: null;
  maxBrowsingLevel: number;
  // Render metadata — SERVER-DERIVED so the preview host's PageBlockHost props are
  // guaranteed to match the token claims (no client-side id reconstruction / drift).
  blockId: string;
  /** Synthetic, non-resolving `pending-<pubreq_…>` — matches the token appId claim. */
  appId: string;
  /** The `pubreq_<ULID>` request id — matches the token appBlockId claim. */
  appBlockId: string;
  /** `page_<pubreq_…>` — matches the token blockInstanceId claim + BLOCK_INIT ids. */
  blockInstanceId: string;
  appName: string;
  /** The pending manifest's declared iframe sandbox (render fidelity). trustTier is
   *  forced 'unverified' at the host → allow-same-origin is dropped regardless. */
  sandbox: string;
  /**
   * MOD REVIEW SANDBOX "run for real" (#2831) — true iff this token was minted
   * with `runForReal:true` (a mod's consent-gated opt-in to run the unapproved app
   * for real against their OWN account). The host uses it to run the REAL
   * side-effect handlers instead of NACKing; default false → render-only sandbox.
   */
  runForReal: boolean;
  /**
   * The AGGREGATE (session) Buzz ceiling the mod's OWN account can spend across
   * all run-for-real generations of THIS request (`REVIEW_RUN_FOR_REAL_BUZZ_CAP`),
   * surfaced so the consent copy + active banner show the exact enforced number.
   * null on a render-only (runForReal:false) mint.
   */
  buzzCap: number | null;
};

/**
 * MOD REVIEW SANDBOX (#2831) — mint the block token the on-site review preview
 * host (`ReviewPreviewPanel` → `PageBlockHost`) handshakes with, so a PENDING,
 * UN-APPROVED block actually renders inside the mod's review modal.
 *
 * SECURITY (this runs UNAPPROVED, untrusted code with a MOD's session — the crux
 * of the whole feature, so the mint is the first defense layer):
 *   - Resolved by `publishRequestId` (NOT ownership — the mod is not the author).
 *     The router gates the call: moderatorProcedure + enforceAppBlocksFlag + the
 *     mod-only `app-blocks-review-sandbox` flag (identical to previewRequest).
 *   - SELF-BOUND: the token `sub` is the calling MOD's id — every self-bound read
 *     (`*:read:self`) can only ever return the MOD's own data, never the author's.
 *   - SCOPE-STRIPPED: the pending manifest's declared `scopes` are the SOURCE, but
 *     they are clamped through the SAME audited belt the dev-tunnel host mint uses
 *     (`clampDevScopes`) with the STRICTEST allowlist (`REVIEW_MINT_SCOPE_ALLOWLIST`
 *     — render-only) and `keyCanSpend:false` (belt-and-suspenders strip of the
 *     spend scope). A manifest that declares `ai:write:budgeted` / `apps:storage:*`
 *     / `buzz:read:self` gets NONE of them — the review JWT can carry only the
 *     render-only survivors.
 *   - FORCED-SFW ceiling + `domain:null` (never reads a request host).
 *   - SYNTHETIC, NON-RESOLVING ids: `appBlockId` = the `pubreq_<ULID>` request id
 *     (an already-recognized `SYNTHETIC_APP_BLOCK_ID_PREFIXES` prefix, so the
 *     best-effort scope-invocation FK-fails and no spend attribution row is forged);
 *     `appId` = the non-resolving `pending-<pubreq_…>` (attribution lookup MISSES).
 *     No `review-` prefix is introduced (mirrors the dev-token pending path).
 *   - SHORT TTL: inherits the dev mint's 4h `dev:true` lifetime.
 * Defense-in-depth continues at the host (`reviewMode` read-only NACKs) and the
 * iframe (forced `trustTier:'unverified'` → opaque origin) — no single layer is
 * load-bearing.
 */
export async function mintReviewBlockToken(opts: {
  publishRequestId: string;
  /** The calling moderator's id — the token `sub` is bound to it (self-bound). */
  modUserId: number;
  /**
   * MOD REVIEW SANDBOX "run for real" (#2831). Default false → the render-only
   * sandbox, BYTE-IDENTICAL to the pre-existing behaviour (render-only allowlist,
   * keyCanSpend:false, no budget, no run-for-real claim). When true (a mod's
   * EXPLICIT, consent-gated opt-in), the SAME audited clamp belt runs with the
   * wider `REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST` and `keyCanSpend:true`, a
   * per-call Buzz budget is attached, and a signed `reviewRunForReal` claim
   * selects the tight aggregate session Buzz cap at runtime. STILL: self-bound to
   * the mod, forced-SFW, money-OUT (`social:tip:self`) excluded, and clamped to
   * (declared ∩ allowlist) — a malicious manifest can never exceed either.
   */
  runForReal?: boolean;
}): Promise<MintReviewBlockTokenResult> {
  const runForReal = opts.runForReal === true;
  const { dbRead } = await import('~/server/db/client');
  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: opts.publishRequestId },
    select: { id: true, status: true, slug: true, manifest: true },
  });
  if (!row) throw new Error(`publish request ${opts.publishRequestId} not found`);
  // Only a PENDING request is previewable — an approved/rejected/withdrawn row has
  // no review preview to mint against (fail-closed, matches previewRequest's remit).
  if (row.status !== 'pending') {
    throw new Error(`publish request ${opts.publishRequestId} is not pending`);
  }

  // Scope SOURCE is the pending request's UN-REVIEWED manifest.scopes (author-
  // controlled, NOT trusted) — clamped DOWN by the render-only belt below. The
  // name/sandbox are render metadata only (never security-load-bearing: trustTier
  // is forced 'unverified' at the host and every side-effect NACKs).
  const manifest = (row.manifest ?? {}) as {
    scopes?: unknown;
    name?: unknown;
    iframe?: { sandbox?: unknown } | null;
    page?: unknown;
  };
  const manifestScopes: string[] = Array.isArray(manifest.scopes)
    ? manifest.scopes.filter((s): s is string => typeof s === 'string')
    : [];
  const manifestName = typeof manifest.name === 'string' ? manifest.name : row.slug;
  const manifestSandbox =
    manifest.iframe && typeof manifest.iframe.sandbox === 'string'
      ? manifest.iframe.sandbox
      : 'allow-scripts';

  const {
    clampDevScopes,
    signDevScopedPageToken,
    REVIEW_MINT_SCOPE_ALLOWLIST,
    REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST,
    resolveDevBuzzBudget,
    parseManifestBuzzBudget,
    FORCED_SFW_CEILING,
  } = await import('./dev-scoped-mint.service');
  const { REVIEW_RUN_FOR_REAL_BUZZ_CAP } = await import(
    '~/shared/constants/block-scope.constants'
  );

  // The AUDITED clamp belt (SAME function both modes — never fork the clamp).
  //   - render-only (default): render-only allowlist + keyCanSpend:false → the
  //     spend scope is stripped even if the manifest declares it. BYTE-IDENTICAL
  //     to the pre-existing sandbox.
  //   - run-for-real (mod opt-in): the WIDER run-for-real allowlist + keyCanSpend:true.
  //     Granted = (manifest DECLARED scopes) ∩ allowlist ∩ (page money-out forbid),
  //     so a malicious manifest declaring extra scopes still gets ONLY declared∩allowlist.
  // NO OAuth ceiling in either mode (a pending app has no OauthClient; passing 0
  // would wrongly strip every non-skip scope — see clampDevScopes doc).
  const granted = clampDevScopes({
    scopeSource: manifestScopes,
    oauthAllowed: null,
    keyCanSpend: runForReal,
    allowlist: runForReal
      ? REVIEW_RUN_FOR_REAL_MINT_SCOPE_ALLOWLIST
      : REVIEW_MINT_SCOPE_ALLOWLIST,
  });

  // Per-call Buzz budget — ONLY for run-for-real AND only if the spend scope
  // survived the clamp. Resolved from the manifest page's declared per-gen budget,
  // hard-clamped to the dev per-call cap (DEV_BUZZ_BUDGET_CAP inside resolveDevBuzzBudget).
  // The AGGREGATE session ceiling (REVIEW_RUN_FOR_REAL_BUZZ_CAP) is enforced
  // separately at runtime — a per-call budget alone can't bound a looping app.
  const buzzBudget = runForReal
    ? resolveDevBuzzBudget(granted, undefined, parseManifestBuzzBudget(manifest.page))
    : undefined;

  // SIGN — self-bound to the MOD, forced-SFW, domain:null, synthetic non-resolving
  // ids (see the fn doc). `signAppBlockId` = the `pubreq_<ULID>` request id (already
  // a recognized SYNTHETIC_APP_BLOCK_ID_PREFIXES prefix); `signAppId` = the
  // non-resolving `pending-<id>` (mirrors the dev-token pending path — the
  // attribution lookup misses so no spend row can be forged). blockInstanceId
  // matches the host's `page_<pubReqId>` prop so BLOCK_INIT ids line up. No spend →
  // no buzzBudget.
  const result = await signDevScopedPageToken({
    userId: opts.modUserId,
    signBlockId: row.slug,
    signAppId: `pending-${row.id}`,
    signAppBlockId: row.id,
    blockInstanceId: `page_${row.id}`,
    granted,
    buzzBudget,
    reviewRunForReal: runForReal,
  });

  // MINT-TIME AUDIT (mirror the `app-blocks.dev-tunnel.mint` structured event):
  // the forensic record of granting a review token over an un-approved app. NEVER
  // log the token. Fire-and-forget — the audit must never fail the mint.
  const { logToAxiom } = await import('~/server/logging/client');
  logToAxiom(
    {
      name: 'app-blocks.review.mint',
      type: 'info',
      modUserId: opts.modUserId,
      publishRequestId: row.id,
      slug: row.slug,
      scopes: granted,
      // Run-for-real is a PRIVILEGED, money-touching action — record the opt-in
      // (and the enforced budgets) distinctly so the forensic trail shows WHEN a
      // mod ran an unapproved app for real against their own account.
      runForReal,
      buzzBudget: buzzBudget ?? null,
      buzzCap: runForReal ? REVIEW_RUN_FOR_REAL_BUZZ_CAP : null,
    },
    'webhooks'
  ).catch(() => null);

  return {
    token: result.token,
    expiresAt: result.expiresAt,
    scopes: granted,
    domain: null,
    maxBrowsingLevel: FORCED_SFW_CEILING,
    blockId: row.slug,
    appId: `pending-${row.id}`,
    appBlockId: row.id,
    blockInstanceId: `page_${row.id}`,
    appName: manifestName,
    sandbox: manifestSandbox,
    runForReal,
    buzzCap: runForReal ? REVIEW_RUN_FOR_REAL_BUZZ_CAP : null,
  };
}

/**
 * Best-effort teardown of any review env attached to a publish request. Called
 * from approveRequest/rejectRequest after the decision lands. NEVER throws into
 * the decision path: it reads the stored review sha (if any) + deletes the
 * review k8s resources by label selector, swallowing every error.
 */
export async function teardownReviewForRequest(publishRequestId: string): Promise<void> {
  // MOD REVIEW SANDBOX "run for real" (#2831) — drop the DISPOSABLE preview
  // storage schema (`apprev_<pubreq>`) a mod may have created by running the app
  // for real. Runs FIRST, in its OWN try/catch, so a downstream failure (the
  // fallible k8s `deleteReviewResources`, or a missing row) can NEVER skip the
  // DROP and leak the mod's preview data in appsDb. Best-effort + idempotent (IF
  // EXISTS): a request that never used preview storage has no schema to drop, and
  // this NEVER touches the approved app's `app_<slug>` schema. Only needs the
  // publishRequestId (not the row), so it's safe to run before the row lookup.
  try {
    const { AppStorageProvisioner } = await import(
      '~/server/services/apps/storage-provision.service'
    );
    await AppStorageProvisioner.deprovisionReviewPreview({ publishRequestId });
  } catch (previewErr) {
    // eslint-disable-next-line no-console
    console.warn(
      `[teardownReviewForRequest] preview-storage teardown failed (id=${publishRequestId}): ${
        previewErr instanceof Error ? previewErr.message : String(previewErr)
      }`
    );
  }
  try {
    const { dbRead } = await import('~/server/db/client');
    const row = await dbRead.appBlockPublishRequest.findUnique({
      where: { id: publishRequestId },
      select: { slug: true, deployState: true, deployDetail: true },
    });
    if (!row) return;
    // Delete by the review LABEL SELECTOR scoped to this publishRequestId. The
    // selector (civitai.com/review-mode=true,publish-request-id=<id>) only ever
    // matches review resources — a live app carries no review-mode label — so
    // this is safe to call unconditionally (idempotent: deletes nothing if no
    // preview was started). We deliberately do NOT gate on deploy_state being a
    // preview-* value: by the time approveRequest calls this, markRequestDeployState
    // has already flipped the (now approved) row's deploy_state to a production
    // 'building' value, so a deploy_state guard would skip the teardown and leak
    // the review env. The label selector is the real safety boundary.
    const detail = parseReviewDetail(row.deployDetail);
    const { deleteReviewResources } = await import('./apps-pipeline.service');
    await deleteReviewResources({
      slug: row.slug,
      sha: detail.sha ?? '',
      publishRequestId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[teardownReviewForRequest] best-effort teardown failed (id=${publishRequestId}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * AGENTIC MOD CODE-REVIEW (P1) — best-effort teardown of any ephemeral review
 * AGENT for a publish request, DECOUPLED from the sandbox-preview teardown
 * (audit #1). Called UNCONDITIONALLY on every approve/reject/withdraw — a review
 * agent can be dispatched WITHOUT ever starting a sandbox preview, so gating this
 * on `hadReviewPreview` (as the sandbox teardown is) would leak the agent's k8s
 * objects + a `running` report row + the staged bundle whenever a mod ran only
 * the agent. Idempotent + label/id-scoped, so it is a no-op when nothing matches.
 *
 * Three best-effort steps (order-independent; none throws into the decision path):
 *   1. delete the review-agent Deployment(s)/Service(s) by label selector,
 *   2. flip any still-`running` report row → `torn-down` so a late callback can't
 *      resurrect it (the callback's running-only guard then no-ops),
 *   3. delete the per-review staged bundle object(s) so staged ZIPs don't
 *      accumulate (audit #2).
 * NEVER throws — mirrors teardownReviewForRequest's best-effort contract.
 */
export async function teardownAgentReviewForRequest(publishRequestId: string): Promise<void> {
  try {
    const { dbWrite } = await import('~/server/db/client');
    // Cheap indexed gate: only pay the k8s + MinIO teardown I/O when an agent
    // review actually ran for this request. Agent reviews are dark/rare, so for
    // the many mod decisions that never trigger an agent this is a single
    // indexed read (AppReviewAgentReport is indexed on publish_request_id), not
    // two network round-trips (k8s LIST+DELETE + MinIO LIST+DELETE) on the live
    // approve/reject/withdraw path.
    const existing = await dbWrite.appReviewAgentReport.findFirst({
      where: { publishRequestId },
      select: { id: true },
    });
    if (!existing) return;
    // (1) agent k8s objects. deleteAgentReviewResources is itself best-effort +
    // never-throws; its label selector is scoped to publishRequestId + the
    // review-agent role, so it can only match this review's agent. `slug` is not
    // part of that selector, so no publish-request lookup is needed here.
    const { deleteAgentReviewResources } = await import('./agent-review.service');
    await deleteAgentReviewResources({ slug: '', publishRequestId });
    // (2) flip any running report row → torn-down.
    await dbWrite.appReviewAgentReport.updateMany({
      where: { publishRequestId, status: 'running' },
      data: { status: 'torn-down', completedAt: new Date() },
    });
    // (3) staged bundle cleanup (best-effort; also lifecycle-backstopped in infra).
    const { deleteStagedBundle } = await import('~/utils/bundle-s3');
    await deleteStagedBundle(publishRequestId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[teardownAgentReviewForRequest] best-effort teardown failed (id=${publishRequestId}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * MANUAL teardown of a single review preview (the mod-facing "Tear down"
 * action + the way to free a slot when the concurrency cap is hit). Distinct
 * from teardownReviewForRequest (fired from approve/reject) in that it ALSO
 * clears the DB preview state so the request returns to the "no preview" state
 * (getReviewStatus → state:null, the active count drops, the UI reverts to
 * "Start preview").
 *
 * Idempotent + label-scoped-per-request (never a broad delete). Only acts on an
 * actual preview (a pending row whose deploy_state is a `preview-*` value); a
 * non-preview / already-cleared / non-pending row is a no-op, NOT an error. The
 * k8s delete is best-effort (errors swallowed) but the DB is cleared regardless,
 * so a stuck row can always be cleared.
 */
export async function teardownPreview(opts: {
  publishRequestId: string;
}): Promise<{ publishRequestId: string; tornDown: boolean }> {
  const { dbRead, dbWrite } = await import('~/server/db/client');
  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: opts.publishRequestId },
    select: { id: true, status: true, deployState: true, deployDetail: true, slug: true },
  });
  if (!row) throw new Error(`publish request ${opts.publishRequestId} not found`);

  const isPreview =
    row.status === 'pending' &&
    typeof row.deployState === 'string' &&
    row.deployState.startsWith('preview-');
  if (!isPreview) return { publishRequestId: row.id, tornDown: false };

  // Best-effort k8s delete, scoped to THIS request by label selector (the
  // per-request selector is the safety boundary — never a broad delete). Swallow
  // k8s errors so a stuck row can always be cleared by the DB write below.
  try {
    const detail = parseReviewDetail(row.deployDetail);
    const { deleteReviewResources } = await import('./apps-pipeline.service');
    await deleteReviewResources({
      slug: row.slug,
      sha: detail.sha ?? '',
      publishRequestId: opts.publishRequestId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[teardownPreview] best-effort k8s delete failed (id=${opts.publishRequestId}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  // Clear the DB regardless of the k8s outcome. Only ever runs when the row was
  // a preview-* state (guarded above), so it can't clobber a production
  // building/live deploy_state.
  await dbWrite.appBlockPublishRequest.update({
    where: { id: opts.publishRequestId },
    data: { deployState: null, deployDetail: null, deployUpdatedAt: new Date() },
  });

  return { publishRequestId: row.id, tornDown: true };
}

export type BackfillPublishRequestParams = {
  slug: string;
  reviewerUserId: number;
  approvalNotes?: string;
};

export type BackfillPublishRequestResult = {
  publishRequestId: string;
  appBlockId: string;
  bundleSha256: string;
  bundleSizeBytes: number;
  fileCount: number;
  forgejoCommitSha: string;
};

/**
 * One-shot W1 migration helper: backfill an `app_block_publish_requests`
 * row for an existing live app whose first version predates the
 * publish-request flow. Pulls the current Forgejo state into a fresh
 * ZIP, uploads it to MinIO, and writes an `status='approved'` row
 * pointed at the live app_blocks entry.
 *
 * After this lands, the next real submitVersion call will diff its
 * bundle against the backfilled bundle's file list, so file_summary
 * change counts are accurate from that point forward.
 *
 * Idempotent at the SHA level — re-running with the same Forgejo HEAD
 * will reuse the existing publish_request if one already exists for
 * this (slug, bundleSha256) pair.
 */
export async function backfillPublishRequest(
  params: BackfillPublishRequestParams
): Promise<BackfillPublishRequestResult> {
  const [{ dbRead, dbWrite }, { newUlid }] = await Promise.all([
    import('~/server/db/client'),
    import('~/server/utils/app-block-ids'),
  ]);
  const { getRepo } = await import('./forgejo.service');

  // Identify the live app row.
  const appBlock = await dbRead.appBlock.findFirst({
    where: { blockId: params.slug },
    select: {
      id: true,
      appId: true,
      manifest: true,
      version: true,
      currentVersionSha: true,
      app: { select: { userId: true } },
    },
  });
  if (!appBlock) {
    throw new Error(`app_blocks row for slug=${params.slug} not found; nothing to backfill`);
  }

  // Pull repo metadata to know the default branch we're snapshotting.
  const repo = await getRepo(params.slug);
  const defaultBranch = repo.default_branch ?? 'main';

  // Reconstruct the bundle from the live repo's default-branch HEAD — same
  // deterministic ZIP build the push-approve path uses (sorted entries +
  // date:new Date(0)) so re-runs with identical repo state produce an identical
  // bundleSha256.
  const bundleBuffer = await reconstructBundleFromForgejo(params.slug, defaultBranch);
  const bundleSha256 = createHash('sha256').update(bundleBuffer).digest('hex');

  // Extract once up-front for consistent file_summary semantics AND the
  // fileCount returned on both the idempotent + fresh paths.
  const { files: fileMetas, manifest } = await extractBundleMetadata(bundleBuffer);
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`backfilled bundle for ${params.slug} has no valid block.manifest.json`);
  }

  // Idempotency: if a publish_request for this exact (slug, sha) already
  // exists, return it instead of inserting a duplicate.
  const existing = await dbRead.appBlockPublishRequest.findFirst({
    where: { slug: params.slug, bundleSha256 },
    select: { id: true, appBlockId: true, bundleSizeBytes: true },
  });
  if (existing) {
    return {
      publishRequestId: existing.id,
      appBlockId: existing.appBlockId ?? appBlock.id,
      bundleSha256,
      bundleSizeBytes: Number(existing.bundleSizeBytes),
      fileCount: fileMetas.length,
      forgejoCommitSha: appBlock.currentVersionSha ?? '',
    };
  }

  // Upload to MinIO. Reuses the storeBundle helper via dynamic import.
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { bundleKey, getBundleBucket, getBundleS3Client } = await import('~/utils/bundle-s3');
  const key = bundleKey(bundleSha256);
  await getBundleS3Client().send(
    new PutObjectCommand({
      Bucket: getBundleBucket(),
      Key: key,
      Body: bundleBuffer,
      ContentType: 'application/zip',
      Metadata: { sha256: bundleSha256, backfilled: 'true' },
    })
  );

  // Synthetic file_summary: first-version style (everything 'added') since
  // there's no prior approved publish_request to diff against.
  const fileSummary: FileSummary = {
    files: fileMetas,
    added: fileMetas.map((f) => f.path).sort(),
    removed: [],
    changed: [],
  };
  const manifestDiffSummary: ManifestDiffSummary = {
    kind: 'first-version',
    fields: Object.keys(manifest as Record<string, unknown>).sort(),
  };

  // Owner attribution from the OauthClient.userId — the original owner of
  // the live app. Reviewer is the mod running the backfill.
  const ownerUserId = appBlock.app.userId;
  const version = appBlock.version ?? '0.0.0-backfill';

  const publishRequestId = `pubreq_${newUlid()}`;
  await dbWrite.appBlockPublishRequest.create({
    data: {
      id: publishRequestId,
      appBlockId: appBlock.id,
      slug: params.slug,
      submittedByUserId: ownerUserId,
      version,
      manifest: manifest as object,
      bundleKey: key,
      bundleSha256,
      bundleSizeBytes: BigInt(bundleBuffer.length),
      fileSummary: fileSummary as object,
      manifestDiffSummary: manifestDiffSummary as object,
      status: 'approved',
      reviewedByUserId: params.reviewerUserId,
      reviewedAt: new Date(),
      approvalNotes:
        params.approvalNotes ??
        `Backfilled W1 migration from existing deployment at ${
          appBlock.currentVersionSha ?? '(unknown sha)'
        }`,
      forgejoCommitSha: appBlock.currentVersionSha ?? bundleSha256,
    },
  });

  return {
    publishRequestId,
    appBlockId: appBlock.id,
    bundleSha256,
    bundleSizeBytes: bundleBuffer.length,
    fileCount: fileMetas.length,
    forgejoCommitSha: appBlock.currentVersionSha ?? '',
  };
}

/**
 * F-E E5 — MOD review: derive the submitted bundle's screenshots for a publish
 * request so the reviewer can SEE the publisher-supplied images before approval
 * (publisher images = an abuse vector → must be reviewed). Re-fetches the stored
 * bundle from MinIO and re-runs `extractScreenshots` (the SAME caps / magic-byte
 * / name validation as submit), returning each as a base64 data URL so the
 * review modal can render plain <img> without a separate public route (the
 * pending app isn't approved → it has no public screenshot URLs yet).
 *
 * Mod-only at the router layer. Returns [] for a request whose bundle has no
 * `screenshots/` dir. The data URLs are bounded by MAX_SCREENSHOT_SIZE_BYTES *
 * MAX_SCREENSHOTS (≈16 MiB worst case) — acceptable for a single mod request.
 */
export type ReviewScreenshot = {
  index: number;
  contentType: string;
  dataUrl: string;
};

export async function getPublishRequestScreenshots(opts: {
  publishRequestId: string;
}): Promise<ReviewScreenshot[]> {
  const { dbRead } = await import('~/server/db/client');
  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: opts.publishRequestId },
    select: { bundleKey: true, slug: true, forgejoCommitSha: true },
  });
  if (!row) throw new Error(`publish request ${opts.publishRequestId} not found`);
  // PUSH-ORIGINATED requests (git-push webhook) carry an empty bundleKey — the
  // reviewable artifact is the Forgejo repo at forgejoCommitSha. Reconstruct the
  // bundle from there (as approveRequest does) instead of issuing an S3
  // GetObject with an empty Key, which throws "Empty value provided for input
  // HTTP label: Key". A row with neither pointer is unexpected → no screenshots.
  if (!row.bundleKey && !row.forgejoCommitSha) return [];
  const bundleBuffer = row.bundleKey
    ? await fetchBundleBuffer(row.bundleKey)
    : await reconstructBundleFromForgejo(row.slug, row.forgejoCommitSha as string);
  const screenshots = await extractScreenshots(bundleBuffer);
  return screenshots.map((s) => ({
    index: s.index,
    contentType: s.contentType,
    dataUrl: `data:${s.contentType};base64,${s.content.toString('base64')}`,
  }));
}

/**
 * Re-fetch the file CONTENTS of the previous APPROVED version's bundle for a
 * slug, excluding a given publish-request id (so a re-review of an already-
 * approved row diffs against the version BEFORE it, not itself). Returns null on
 * a first version (no prior approved row) or a prior row with no fetchable
 * bundle (empty bundleKey + no forgejoCommitSha — shouldn't happen for an
 * approved row, but handled defensively → treated as first-version).
 *
 * Unlike getPreviousApprovedState (which reads only the stored path+sha
 * fileSummary), the line diff needs the actual bytes, so this GETs the prior
 * bundle from MinIO (ZIP path) or reconstructs it from Forgejo (push path).
 */
async function getPreviousApprovedFiles(
  slug: string,
  excludePublishRequestId?: string
): Promise<Array<{ path: string; content: Buffer }> | null> {
  const { dbRead } = await import('~/server/db/client');
  const prior = await dbRead.appBlockPublishRequest.findFirst({
    where: {
      slug,
      status: 'approved',
      ...(excludePublishRequestId ? { NOT: { id: excludePublishRequestId } } : {}),
    },
    orderBy: { reviewedAt: 'desc' },
    select: { bundleKey: true, slug: true, forgejoCommitSha: true },
  });
  if (!prior) return null;
  if (!prior.bundleKey && !prior.forgejoCommitSha) return null;
  const bundleBuffer = prior.bundleKey
    ? await fetchBundleBuffer(prior.bundleKey)
    : await reconstructBundleFromForgejo(prior.slug, prior.forgejoCommitSha as string);
  return extractBundleFilesFromBuffer(bundleBuffer);
}

/**
 * MOD review: compute the per-file UNIFIED LINE diff between a publish request's
 * pending bundle and the previous approved version, so the reviewer can read the
 * actual code change in the modal (closing the "see exactly what changed" gap —
 * the file/manifest summaries only show WHICH files changed).
 *
 * Re-fetches the pending bundle (MinIO ZIP path or Forgejo push path, mirroring
 * getPublishRequestScreenshots) + the previous approved bundle's bytes, then
 * runs the pure, bounded computeBundleLineDiff. Binary / oversized / huge-diff
 * files are explicitly marked elided (never inlined) so the UI labels them with
 * the reason instead of rendering them. First version ⇒ every file is a
 * whole-file add.
 *
 * Mod-only at the router layer.
 */
export async function getPublishRequestDiff(opts: {
  publishRequestId: string;
}): Promise<BundleLineDiff> {
  const { dbRead } = await import('~/server/db/client');
  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: opts.publishRequestId },
    select: { bundleKey: true, slug: true, forgejoCommitSha: true },
  });
  if (!row) throw new Error(`publish request ${opts.publishRequestId} not found`);
  // PUSH-ORIGINATED requests carry an empty bundleKey — reconstruct from Forgejo
  // at the pushed sha (as approveRequest / getPublishRequestScreenshots do). A
  // row with neither pointer is unexpected → no diffable artifact.
  if (!row.bundleKey && !row.forgejoCommitSha) {
    return { files: [], truncated: false };
  }
  const bundleBuffer = row.bundleKey
    ? await fetchBundleBuffer(row.bundleKey)
    : await reconstructBundleFromForgejo(row.slug, row.forgejoCommitSha as string);
  const currentFiles = await extractBundleFilesFromBuffer(bundleBuffer);
  // Diff against the version BEFORE this row (exclude self so re-reviewing an
  // approved row doesn't compare it to itself → an all-empty diff).
  const previousFiles = await getPreviousApprovedFiles(row.slug, opts.publishRequestId);
  return computeBundleLineDiff(currentFiles, previousFiles);
}

export type RejectRequestParams = {
  publishRequestId: string;
  reviewerUserId: number;
  rejectionReason: string;
};

/**
 * Reject a pending publish request. Reason is required and shown to the
 * dev inline on /apps/my-submissions.
 */
export async function rejectRequest(params: RejectRequestParams): Promise<void> {
  const { dbRead, dbWrite } = await import('~/server/db/client');
  const reason = params.rejectionReason.trim();
  if (reason.length < PUBLISH_REJECTION_REASON_MIN) {
    throw new Error(
      `rejection reason must be at least ${PUBLISH_REJECTION_REASON_MIN} characters`
    );
  }
  if (reason.length > PUBLISH_REJECTION_REASON_MAX) {
    throw new Error(
      `rejection reason must be at most ${PUBLISH_REJECTION_REASON_MAX} characters`
    );
  }

  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: params.publishRequestId },
    // deployState (#2831): only fire the review teardown if a preview was started.
    // slug/version/manifest/submittedByUserId feed the POST-COMMIT submitter
    // notification (best-effort; see below).
    select: {
      id: true,
      status: true,
      deployState: true,
      slug: true,
      version: true,
      manifest: true,
      submittedByUserId: true,
    },
  });
  if (!row) throw new Error(`publish request ${params.publishRequestId} not found`);
  if (row.status !== 'pending') {
    throw new Error(`cannot reject a request in status ${row.status}`);
  }
  const hadReviewPreview =
    typeof row.deployState === 'string' && row.deployState.startsWith('preview-');

  await dbWrite.appBlockPublishRequest.update({
    where: { id: row.id },
    data: {
      status: 'rejected',
      reviewedByUserId: params.reviewerUserId,
      reviewedAt: new Date(),
      rejectionReason: reason,
    },
  });

  // W13 draft-at-submit — a first-version REJECT discards the pre-approval DRAFT
  // listing (release the slug + drop unreviewed media), mirroring the off-site
  // `closeTerminalListing` draft branch. No-op for a subsequent version (no draft) or a
  // legacy pre-ship pending request. Best-effort: the reject has already committed, so a
  // cleanup failure must never fail the outcome.
  try {
    await deleteOnsiteDraftListingForSlug({ slug: row.slug });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[rejectRequest] pre-approval draft cleanup failed (id=${params.publishRequestId}, slug=${row.slug}); ` +
        `reject STANDS: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // MOD REVIEW SANDBOX (#2831) — tear down any review env the mod spun up.
  // Best-effort + non-blocking: the reject has landed, so a teardown failure
  // must never affect the outcome. Gated on a preview actually having been
  // started so the common no-preview reject does zero extra work.
  if (hadReviewPreview) void teardownReviewForRequest(row.id);
  // AGENTIC REVIEW (P1, audit #1) — tear down any review AGENT UNCONDITIONALLY
  // (an agent can run without a sandbox preview). Idempotent no-op otherwise.
  void teardownAgentReviewForRequest(row.id);

  // POST-COMMIT, best-effort — notify the submitting developer their block was NOT
  // approved, carrying the (already-trimmed) moderator reason so it shows inline on
  // /apps/my-submissions. Runs AFTER the status flip to 'rejected' commits (a reject
  // that throws above — bad reason length, non-pending row — never reaches here → no
  // notification). Wrapped so a notification failure can NEVER fail the reject.
  // Keyed by the request id for idempotency.
  const rejectManifest =
    row.manifest && typeof row.manifest === 'object'
      ? (row.manifest as Record<string, unknown>)
      : {};
  try {
    await notifyAppBlockSubmitter({
      type: 'app-block-rejected',
      userId: row.submittedByUserId,
      key: `app-block-rejected:${params.publishRequestId}`,
      details: {
        slug: row.slug,
        name: typeof rejectManifest.name === 'string' ? rejectManifest.name : null,
        version: row.version,
        reason,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[rejectRequest] submitter notification failed (id=${params.publishRequestId}); ` +
        `reject stands: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
