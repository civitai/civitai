import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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
 * Re-fetch the bundle from MinIO and extract path → content map. Used
 * during approve to push files to Forgejo. Returns Buffer per file (we
 * need binary fidelity for non-text files).
 */
async function fetchAndExtractBundleFiles(
  bundleKey: string
): Promise<Array<{ path: string; content: Buffer }>> {
  const { getBundleBucket, getBundleS3Client } = await import('~/utils/bundle-s3');
  const client = getBundleS3Client();
  const obj = await client.send(
    new GetObjectCommand({ Bucket: getBundleBucket(), Key: bundleKey })
  );
  if (!obj.Body) throw new Error(`bundle ${bundleKey} not found in S3`);
  const bytes = await obj.Body.transformToByteArray();
  const bundleBuffer = Buffer.from(bytes);

  const zip = await JSZip.loadAsync(bundleBuffer);
  const out: Array<{ path: string; content: Buffer }> = [];
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    out.push({ path, content: await entry.async('nodebuffer') });
  }
  return out;
}

export type ListPendingRequestsOptions = {
  limit?: number;
  cursor?: string;
};

/**
 * Mod queue: paginated list of publish requests in status='pending',
 * oldest first (FIFO). Includes the submitter's basic profile so the
 * review UI doesn't round-trip per row.
 */
export async function listPendingRequests(opts: ListPendingRequestsOptions = {}) {
  const { dbRead } = await import('~/server/db/client');
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
 *   3. pre-insert app_blocks row (status='approved') so the downstream
 *      Forgejo webhook (existing git-push handler) finds it
 *   4. fetch bundle from MinIO, extract files
 *   5. commitFiles to Forgejo (single atomic commit, replaceAllFiles=true)
 *   6. update publish_request → status='approved'
 *
 * The Forgejo push webhook fires from step 5 and the existing git-push
 * handler takes over: validates manifest, updates app_blocks
 * (currentVersionSha), triggers Tekton build.
 *
 * Partial-state risk: if step 5 fails after step 1-3 succeeded, the
 * OauthClient + app_blocks rows are orphaned. v0 surfaces this; v1
 * adds a compensation transaction.
 */
export async function approveRequest(
  params: ApproveRequestParams
): Promise<ApproveRequestResult> {
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
      submittedByUserId: true,
      appBlockId: true,
    },
  });
  if (!request) throw new Error(`publish request ${params.publishRequestId} not found`);
  if (request.status !== 'pending') {
    throw new Error(`cannot approve a request in status ${request.status}`);
  }

  const manifest = request.manifest as Record<string, unknown>;
  const manifestScopes = Array.isArray(manifest.scopes)
    ? (manifest.scopes as string[])
    : [];
  const manifestContentRating =
    typeof manifest.contentRating === 'string' ? manifest.contentRating : 'g';
  const manifestRenderMode =
    typeof manifest.renderMode === 'string' ? manifest.renderMode : 'iframe';
  const manifestTrustTier =
    typeof manifest.trustTier === 'string' ? manifest.trustTier : 'internal';

  // Determine first-vs-subsequent via the existing app_blocks row.
  // We don't rely on request.appBlockId being null because two requests
  // could land for the same slug before the first is approved.
  const existingAppBlock = await dbRead.appBlock.findFirst({
    where: { blockId: request.slug },
    select: { id: true, appId: true, repoUrl: true },
  });
  const isFirstVersion = !existingAppBlock;

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
    const callbackUrl = `${(process.env.NEXTAUTH_URL ?? '').replace(/\/$/, '')}/api/internal/blocks/git-push`;
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
          trustTier: manifestTrustTier,
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
          trustTier: manifestTrustTier,
          approvedScopes: manifestScopes,
          repoUrl,
        },
      });
    }
  } else {
    appBlockId = existingAppBlock.id;
    repoUrl = existingAppBlock.repoUrl ?? '';
    // Subsequent version: refresh manifest + version + approvedScopes
    // on the existing row. currentVersionSha is updated by the
    // git-push webhook after the upcoming Forgejo commit.
    await dbWrite.appBlock.update({
      where: { id: appBlockId },
      data: {
        manifest: manifest as object,
        version: request.version,
        approvedScopes: manifestScopes,
        contentRating: manifestContentRating,
        renderMode: manifestRenderMode,
        trustTier: manifestTrustTier,
      },
    });
  }

  // (4) Fetch + extract bundle. Single MinIO GET; the per-file extract
  // happens in-memory.
  const files = await fetchAndExtractBundleFiles(request.bundleKey);

  // (5) Atomic single-commit replacement of the repo contents. Fires
  // exactly one Forgejo webhook → one git-push handler invocation →
  // one Tekton build → one apply Job.
  const commitMessage = `Approved publish request ${request.id} — ${request.slug} v${request.version}`;
  const { sha: forgejoCommitSha } = await commitFiles({
    slug: request.slug,
    files,
    message: commitMessage,
    replaceAllFiles: true,
  });

  // (6) Finalise the publish request.
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

  return {
    publishRequestId: request.id,
    appBlockId,
    forgejoCommitSha,
    isFirstVersion,
  };
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
  const { getRepo, listRepoTree, getBlobContent } = await import('./forgejo.service');

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

  // Pull repo metadata to know the default branch + the current commit SHA
  // we're snapshotting.
  const repo = await getRepo(params.slug);
  const defaultBranch = repo.default_branch ?? 'main';

  // Recursively list blobs in the default branch, then download each blob's
  // raw bytes in parallel (capped at 8 in flight to avoid hammering Forgejo).
  const tree = await listRepoTree(params.slug, defaultBranch);
  const entries = Array.from(tree.entries()).map(([path, blobSha]) => ({ path, blobSha }));

  const CONCURRENCY = 8;
  const files: Array<{ path: string; content: Buffer }> = [];
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(
      batch.map(async (e) => ({ path: e.path, content: await getBlobContent(params.slug, e.blobSha) }))
    );
    files.push(...fetched);
  }

  // Build an in-memory ZIP — same shape a developer would have uploaded.
  // Generate deterministic-ish so re-runs with identical repo state produce
  // identical bundleSha256.
  const zip = new JSZip();
  for (const f of files) zip.file(f.path, f.content, { date: new Date(0) });
  const bundleBuffer = Buffer.from(
    await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  );
  const bundleSha256 = createHash('sha256').update(bundleBuffer).digest('hex');

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
      fileCount: files.length,
      forgejoCommitSha: appBlock.currentVersionSha ?? '',
    };
  }

  // Reuse the submit path's extract for consistent file_summary semantics.
  const { files: fileMetas, manifest } = await extractBundleMetadata(bundleBuffer);
  if (!manifest || typeof manifest !== 'object') {
    throw new Error(`backfilled bundle for ${params.slug} has no valid block.manifest.json`);
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
        `Backfilled W1 migration from existing deployment at ${appBlock.currentVersionSha ?? '(unknown sha)'}`,
      forgejoCommitSha: appBlock.currentVersionSha ?? bundleSha256,
    },
  });

  return {
    publishRequestId,
    appBlockId: appBlock.id,
    bundleSha256,
    bundleSizeBytes: bundleBuffer.length,
    fileCount: files.length,
    forgejoCommitSha: appBlock.currentVersionSha ?? '',
  };
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
