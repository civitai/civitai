import { PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import JSZip from 'jszip';
import {
  MAX_BUNDLE_SIZE_BYTES,
  MAX_FILES_IN_BUNDLE,
  MAX_FILE_SIZE_BYTES,
} from '~/server/schema/blocks/publish-request.schema';

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
  slug: string;
  version: string;
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
      (k) =>
        `${JSON.stringify(k)}:${stableJsonStringify((value as Record<string, unknown>)[k])}`
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
 * Extract every file in the ZIP as { path, sha256, sizeBytes }. Validates
 * file-count, per-file size, and that block.manifest.json is present and
 * parseable. Returns the parsed manifest alongside the file map so the
 * caller doesn't re-scan the ZIP.
 *
 * Throws on: too many files, file too large, missing manifest, manifest
 * not valid JSON, directory-traversal paths.
 */
export async function extractBundleMetadata(bundleBuffer: Buffer): Promise<{
  files: FileMeta[];
  manifest: unknown;
}> {
  const zip = await JSZip.loadAsync(bundleBuffer);
  const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
  if (entries.length === 0) {
    throw new Error('bundle is empty (no files)');
  }
  if (entries.length > MAX_FILES_IN_BUNDLE) {
    throw new Error(`bundle contains ${entries.length} files (max ${MAX_FILES_IN_BUNDLE})`);
  }

  const files: FileMeta[] = [];
  let manifestRaw: string | null = null;

  for (const [rawPath, entry] of entries) {
    // No filesystem-traversal guard needed: jszip normalises `..`
    // segments out of entry paths, and the approve flow uploads files
    // via the Forgejo content API (repo-relative paths, no fs writes).
    const contents = await entry.async('nodebuffer');
    if (contents.length > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `bundle file ${rawPath} is ${contents.length} bytes (max ${MAX_FILE_SIZE_BYTES})`
      );
    }
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
  const allKeys = new Set([
    ...Object.keys(currentManifest),
    ...Object.keys(previousManifest),
  ]);
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
  const [{ dbRead, dbWrite }, { newUlid }] = await Promise.all([
    import('~/server/db/client'),
    import('~/server/utils/app-block-ids'),
  ]);
  const { slug, version, bundleBuffer, submittedByUserId } = params;

  if (bundleBuffer.length > MAX_BUNDLE_SIZE_BYTES) {
    throw new Error(
      `bundle is ${bundleBuffer.length} bytes (max ${MAX_BUNDLE_SIZE_BYTES})`
    );
  }
  if (bundleBuffer.length === 0) {
    throw new Error('bundle is empty');
  }

  const bundleSha256 = createHash('sha256').update(bundleBuffer).digest('hex');

  // Block double-submit on the same slug — only one pending request per
  // slug at a time. Caller's UI should withdraw the existing pending
  // request before re-submitting.
  const conflicting = await dbRead.appBlockPublishRequest.findFirst({
    where: { slug, status: 'pending' },
    select: { id: true, submittedByUserId: true },
  });
  if (conflicting) {
    throw new Error(
      `slug ${slug} already has a pending publish request (${conflicting.id}); withdraw it before resubmitting`
    );
  }

  // For subsequent versions, link to the existing app row.
  const existingApp = await dbRead.appBlock.findFirst({
    where: { blockId: slug },
    select: { id: true, appId: true },
  });

  // Extract + validate the bundle.
  const { files, manifest: rawManifest } = await extractBundleMetadata(bundleBuffer);
  if (!rawManifest || typeof rawManifest !== 'object') {
    throw new Error(`${MANIFEST_PATH} must contain a JSON object`);
  }
  const manifest = rawManifest as Record<string, unknown>;

  // Manifest cross-checks against the form: blockId in the manifest must
  // match the slug; version in the manifest must match the submitted
  // version. (The deep validation of contentRating / scopes / iframe /
  // targets happens at the BlockManifestValidator step in the approve
  // flow, when the OauthClient with allowedOrigins is known.)
  if (manifest.blockId !== slug) {
    throw new Error(`manifest blockId (${manifest.blockId}) does not match form slug (${slug})`);
  }
  if (manifest.version !== version) {
    throw new Error(
      `manifest version (${manifest.version}) does not match form version (${version})`
    );
  }
  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error('manifest.name must be a non-empty string');
  }

  // Diff against the previous approved version (if any).
  const previous = await getPreviousApprovedState(slug);
  const fileSummary = computeFileDiff(files, previous?.files ?? null);
  const manifestDiffSummary = computeManifestDiff(manifest, previous?.manifest ?? null);

  // Upload bundle LAST so a validation failure never leaves a dangling
  // object behind. PutObject is idempotent on the SHA, so a retry after
  // an upstream error reuses the same key safely.
  const key = await storeBundle(bundleBuffer, bundleSha256);

  const publishRequestId = `pubreq_${newUlid()}`;
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
