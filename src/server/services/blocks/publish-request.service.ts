import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import JSZip from 'jszip';
import {
  MAX_BUNDLE_SIZE_BYTES,
  MAX_FILES_IN_BUNDLE,
  MAX_FILE_SIZE_BYTES,
  MAX_SCREENSHOT_SIZE_BYTES,
  MAX_SCREENSHOTS,
  MAX_TOTAL_DECOMPRESSED_BYTES,
  SCREENSHOT_DIR,
  SCREENSHOT_EXTENSIONS,
  type ScreenshotExtension,
} from '~/server/schema/blocks/publish-request.schema';
// Pure shared module (only depends on token-scope.constants) — safe to import
// statically without coupling to env/Prisma, so the pure-helper tests still run.
import { deriveOauthBitmaskFromBlockScopes } from '~/shared/constants/block-scope.constants';
// Pure (no env/Prisma) — stamps the platform-owned iframe.src onto a manifest.
import { stampCanonicalIframeSrc } from '~/server/services/blocks/manifest-normalize';

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
};

async function storeScreenshots(
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
          footer: { text: 'App Blocks publish-request queue' },
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
  const [{ dbRead, dbWrite }, { newUlid }, { SEMVER_REGEX, SLUG_REGEX }] = await Promise.all([
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
        `you already have a pending submission for slug ${slug} (${conflicting.id}); withdraw it before resubmitting`
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
 * Dev-facing withdrawal of their own pending request. Idempotent
 * (re-withdrawing is a no-op if already withdrawn). Throws on attempting
 * to withdraw someone else's request.
 */
export async function withdrawRequest(opts: {
  publishRequestId: string;
  userId: number;
}): Promise<void> {
  const { dbRead, dbWrite } = await import('~/server/db/client');
  const { publishRequestId, userId } = opts;
  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: publishRequestId },
    select: { id: true, status: true, submittedByUserId: true },
  });
  if (!row) throw new Error(`publish request ${publishRequestId} not found`);
  if (row.submittedByUserId !== userId) {
    throw new Error('you can only withdraw your own publish requests');
  }
  if (row.status === 'withdrawn') return;
  if (row.status !== 'pending') {
    throw new Error(`cannot withdraw a request in status ${row.status}`);
  }
  await dbWrite.appBlockPublishRequest.update({
    where: { id: publishRequestId },
    data: { status: 'withdrawn' },
  });
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
      bundleKey: true,
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
      // PUSH-ORIGINATED requests (empty bundleSha256) have no review-org
      // snapshot — link mods to the CANONICAL repo at the exact pushed sha
      // instead, so they can review the real code rather than approve blind.
      pushCommitUrl:
        !r.bundleKey && r.forgejoCommitSha
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
      bundleKey: true,
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
      pushCommitUrl:
        !r.bundleKey && r.forgejoCommitSha
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
      bundleKey: true,
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
      pushCommitUrl:
        !r.bundleKey && r.forgejoCommitSha
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
    },
  });
  if (!request) throw new Error(`publish request ${params.publishRequestId} not found`);
  if (request.status !== 'pending') {
    throw new Error(`cannot approve a request in status ${request.status}`);
  }

  const manifest = request.manifest as Record<string, unknown>;
  const manifestScopes = Array.isArray(manifest.scopes) ? (manifest.scopes as string[]) : [];
  const manifestContentRating =
    typeof manifest.contentRating === 'string' ? manifest.contentRating : 'g';
  const manifestRenderMode =
    typeof manifest.renderMode === 'string' ? manifest.renderMode : 'iframe';

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
  const validation = BlockManifestValidator.validate(manifest, validationCtx);
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
  if (reason.length < 10) {
    throw new Error('rejection reason must be at least 10 characters');
  }
  if (reason.length > 2000) {
    throw new Error('rejection reason must be at most 2000 characters');
  }

  const row = await dbRead.appBlockPublishRequest.findUnique({
    where: { id: params.publishRequestId },
    select: { id: true, status: true },
  });
  if (!row) throw new Error(`publish request ${params.publishRequestId} not found`);
  if (row.status !== 'pending') {
    throw new Error(`cannot reject a request in status ${row.status}`);
  }

  await dbWrite.appBlockPublishRequest.update({
    where: { id: row.id },
    data: {
      status: 'rejected',
      reviewedByUserId: params.reviewerUserId,
      reviewedAt: new Date(),
      rejectionReason: reason,
    },
  });
}
