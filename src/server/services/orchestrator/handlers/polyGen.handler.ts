/**
 * PolyGen Result Handler
 *
 * Processes a finished PolyGen (Meshy via Fal) workflow into a Draft
 * `Model3D` row. Called from the orchestrator poll loop / webhook.
 * Normalises blob formats, copies outputs to S3 (`3d/` prefix), ingests
 * the thumbnail as a real `Image`, and upserts the `Model3D` +
 * `Model3DFile` rows. Idempotent on `Model3D.workflowId`.
 *
 * Submission lives elsewhere now: PolyGen rides the unified V2 pipeline
 * (`generateFromGraph` → `createPolyGenInput` in `polygen-graph.handler.ts`).
 * The bespoke `submitPolyGenWorkflow` + `buildPolyGenStep` helpers that
 * used to live here were retired alongside the deprecated `generate3D` /
 * `generate3DWhatIf` tRPC mutations.
 */

import type { ImageBlob, Model3dBlob, PolyGenOutput, Workflow } from '@civitai/client';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { env } from '~/env/server';
import { logToAxiom } from '~/server/logging/client';
import type { Model3DGenerationSchema } from '~/server/orchestrator/polygen/polygen.schema';
import { createImage } from '~/server/services/image.service';
import { upsertModel3DFromWorkflow } from '~/server/services/model3d.service';
import { registerMediaLocation } from '~/server/services/storage-resolver';
import { getImageUploadBackend, getUploadBucket, getUploadS3Client } from '~/utils/s3-utils';
import type { Prisma } from '@prisma/client';

// =============================================================================
// Constants
// =============================================================================

const POLYGEN_S3_PREFIX = '3d/';
const PRIMARY_FORMAT = 'glb';
const POLYGEN_LOG = 'polygen-handler';

// =============================================================================
// Result handling
// =============================================================================

export type HandlePolyGenResultArgs = {
  /** Orchestrator workflow id (also Model3D.workflowId — UNIQUE). */
  workflowId: string;
  /** The owning user; copied to Model3D.userId for new drafts. */
  userId: number;
  /** The PolyGen step output, as returned by the orchestrator. */
  output: PolyGenOutput;
  /** The original form input (snapshot for `Model3D.generationParams`). */
  generationParams: Model3DGenerationSchema;
  /**
   * For imageTo3D: the previously-ingested source `Image.id`. The Model3D
   * row's `sourceImageId` FK gets this value. The form layer should call
   * `ingestImage` BEFORE submission and pass the resulting id back so the
   * orchestrator-bound `imageUrl` and the DB record agree.
   */
  sourceImageId?: number;
  /** Optional Model3DLicense id; falls back to the seed default if omitted. */
  licenseId?: number;
  /**
   * Preferred thumbnail source — the chained `model3DPreview` step's rendered
   * image. When present it's ingested instead of the polyGen-emitted
   * `output.thumbnail` (an uncontrollable, off-angle auto-render), so the saved
   * Model3D's thumbnail matches the centered preview the user saw in the queue.
   */
  thumbnailOverride?: ImageBlob;
};

export type PolyGenResult = {
  /** Internal Model3D row id (whether freshly created or existing). */
  model3dId: number;
  /** True if this call created the draft; false if it returned an existing row. */
  created: boolean;
};

/**
 * Process a completed PolyGen workflow:
 *  1. Normalize each `Model3dBlob.format` (lowercase, strip leading dot)
 *  2. Copy GLB / FBX blobs into our S3 under `3d/`
 *  3. Ingest the output thumbnail as a real `Image` row via the standard
 *     image-ingest pipeline (NSFW / CSAM scan etc.)
 *  4. Upsert the `Model3D` row in Draft status, keyed on `workflowId`
 *  5. Create `Model3DFile` rows, one per format. GLB marked `isPrimary`.
 *
 * Idempotent: re-running on the same workflowId returns the existing draft.
 */
export async function handlePolyGenWorkflowResult(
  args: HandlePolyGenResultArgs
): Promise<PolyGenResult> {
  const { workflowId, userId, output, generationParams, sourceImageId } = args;
  // licenseId falls back to a seeded default. The seed in the migration inserts
  // these by name; row 5 ("All Rights Reserved") is the most conservative default.
  const licenseId = args.licenseId ?? DEFAULT_MODEL3D_LICENSE_ID;

  // ---------------------------------------------------------------------------
  // 1. Collect + normalize every PolyGen output blob with its variant tag.
  //
  // A single workflow can emit up to ~12 files for a fully-rigged +
  // animated generation: base (glb + fbx), rigged (glb + fbx), animated
  // (glb + fbx), walking (glb + fbx + armature), running (glb + fbx +
  // armature). The `variant` discriminator on Model3DFile is what lets
  // them coexist under the `(model3dId, format, variant)` unique index.
  // ---------------------------------------------------------------------------
  const blobs: { format: string; variant: string; blob: Model3dBlob }[] = [];
  const pushBlob = (variant: string, blob: Model3dBlob | undefined | null) => {
    if (!blob) return;
    blobs.push({ format: normalizeFormat(blob.format), variant, blob });
  };

  pushBlob('primary', output.model);
  pushBlob('primary', output.fbxModel);
  pushBlob('rigged', output.riggedModel);
  pushBlob('rigged', output.riggedFbxModel);
  pushBlob('animated', output.animatedModel);
  pushBlob('animated', output.animatedFbxModel);
  const ba = output.basicAnimations;
  if (ba) {
    pushBlob('walking', ba.walkingModel);
    pushBlob('walking', ba.walkingFbxModel);
    pushBlob('walking-armature', ba.walkingArmatureModel);
    pushBlob('running', ba.runningModel);
    pushBlob('running', ba.runningFbxModel);
    pushBlob('running-armature', ba.runningArmatureModel);
  }

  if (blobs.length === 0) {
    throw new Error(`PolyGen workflow ${workflowId} produced no model blobs`);
  }

  // ---------------------------------------------------------------------------
  // 2. Copy each model blob into our S3 (`3d/<uuid>.<format>`)
  // ---------------------------------------------------------------------------
  const copiedFiles: CopiedModelFile[] = [];
  for (const { format, variant, blob } of blobs) {
    const copied = await copyModel3dBlobToS3(blob, format);
    if (!copied) {
      // A failing blob copy isn't an immediate hard stop if at least one
      // other blob (typically the primary GLB) succeeds. We log + continue.
      logToAxiom({
        name: POLYGEN_LOG,
        type: 'warn',
        message: 'Failed to copy model3d blob',
        workflowId,
        format,
        variant,
      }).catch(() => undefined);
      continue;
    }
    copiedFiles.push({ ...copied, variant });
  }

  if (copiedFiles.length === 0) {
    throw new Error(`PolyGen workflow ${workflowId} had blobs but none could be copied to S3`);
  }

  // ---------------------------------------------------------------------------
  // 3. Ingest the thumbnail image (if any) into the standard Image pipeline.
  //    Prefer the model3DPreview render over the polyGen auto-thumbnail.
  // ---------------------------------------------------------------------------
  const thumbnailSource = args.thumbnailOverride ?? output.thumbnail;
  let thumbnailImageId: number | undefined;
  if (thumbnailSource) {
    thumbnailImageId = await ingestThumbnailImage(thumbnailSource, userId, workflowId);
  }

  // ---------------------------------------------------------------------------
  // 4. Upsert the Model3D draft row + Model3DFile rows (idempotent on workflowId)
  // ---------------------------------------------------------------------------
  // Choose the single primary file. The base GLB is preferred (the inline
  // viewer mounts it and the gallery thumbnail derives from it). Some
  // ecosystems don't emit a GLB — e.g. Tripo with `quad: true` outputs FBX
  // only — so fall back to the first primary-variant file (any format) so the
  // record still has a coherent primary; the viewer degrades to its
  // "download to view" panel for non-GLB. Rigged/animated/template files are
  // never primary.
  const primaryVariant = (variant?: string) => (variant ?? 'primary') === 'primary';
  const glbPrimaryIndex = copiedFiles.findIndex(
    (f) => f.format === PRIMARY_FORMAT && primaryVariant(f.variant)
  );
  const primaryIndex =
    glbPrimaryIndex >= 0
      ? glbPrimaryIndex
      : copiedFiles.findIndex((f) => primaryVariant(f.variant));

  const { id, created } = await upsertModel3DFromWorkflow({
    workflowId,
    userId,
    thumbnailImageId,
    sourceImageId,
    licenseId,
    generationParams: generationParams as Prisma.InputJsonValue,
    files: copiedFiles.map(({ url, format, sizeKB, variant }, index) => ({
      // File name includes the variant so the Save-to-Library download
      // dropdown doesn't end up with multiple "<wf>.glb" entries — the
      // ones from rigged/animated/walking/running need to be
      // distinguishable on disk after a user downloads them all.
      name: deriveFileName(workflowId, format, variant ?? 'primary'),
      url,
      format,
      sizeKB,
      isPrimary: index === primaryIndex,
      variant: variant ?? 'primary',
    })),
  });

  logToAxiom({
    name: POLYGEN_LOG,
    type: 'info',
    message: created
      ? 'PolyGen Model3D draft created'
      : 'PolyGen Model3D draft already exists (idempotent)',
    workflowId,
    model3dId: id,
    userId,
    thumbnailImageId,
    sourceImageId,
    licenseId,
    files: copiedFiles.map((f) => ({ format: f.format, url: f.url, sizeKB: f.sizeKB })),
  }).catch(() => undefined);

  return { model3dId: id, created };
}

/**
 * Default license id assigned when the workflow result handler isn't given one.
 * Maps to the seeded "All Rights Reserved" row (id 5 in the migration seed).
 * Override at call-time if the form passes a user-selected licenseId.
 */
const DEFAULT_MODEL3D_LICENSE_ID = 5;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Lowercase + strip a leading dot from a free-text format string so
 * "GLB", ".glb", and "glb" all hash to the same DB row.
 */
export function normalizeFormat(format: string): string {
  return String(format ?? '')
    .toLowerCase()
    .replace(/^\./, '');
}

/** A model3d blob that has been copied to our S3, ready for a Model3DFile row. */
type CopiedModelFile = {
  format: string;
  /**
   * Full B2 URL (path-style) — `Model3DFile.url` stores this. Storing a
   * full URL (rather than a bare key) means `getModel3DFiles` can sign it
   * through the existing `isFullUrl + isB2Url` path against the model
   * upload bucket, exactly the way moderator-seeded files are signed.
   */
  url: string;
  /** File size in kilobytes (Model3DFile.sizeKB) */
  sizeKB: number;
  /**
   * Variant discriminator for the Model3DFile row — populated by the
   * caller after a successful copy. See `pushBlob` in
   * `handlePolyGenWorkflowResult` for the canonical variant strings.
   */
  variant?: string;
};

/**
 * Download a `Model3dBlob` and re-upload it to our own S3 bucket. Returns
 * null if the blob is unavailable / has no usable URL (the caller logs
 * and continues, so a single bad alt-format doesn't fail the whole draft).
 *
 * NOTE: `Model3dBlob.url` is nullable and `urlExpiresAt` may already be
 * in the past — orchestrator-provided URLs are presigned with short
 * expirations. If a fetch fails we surface the failure to the caller; a
 * higher-level retry policy can poll the orchestrator for a fresh URL.
 *
 * Destination is the **model** B2 bucket (`getUploadBucket('b2')`), not
 * the image bucket — these are downloadable 3D assets, semantically
 * identical to user-uploaded `.glb` / `.fbx` files, and `getModel3DFiles`
 * is wired to sign B2-backed URLs against that bucket.
 */
async function copyModel3dBlobToS3(
  blob: Model3dBlob,
  format: string
): Promise<CopiedModelFile | null> {
  const url = blob.url;
  if (!url) return null;

  // Graceful expiry check — if we can tell it's expired we surface that
  // distinctly from a network error.
  if (blob.urlExpiresAt) {
    const expiresAt = new Date(blob.urlExpiresAt).getTime();
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      logToAxiom({
        name: POLYGEN_LOG,
        type: 'warn',
        message: 'Model3dBlob URL already expired before copy',
        format,
        urlExpiresAt: blob.urlExpiresAt,
      }).catch(() => undefined);
      return null;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  const safeFormat = format || 'bin';
  const s3Key = `${POLYGEN_S3_PREFIX}${randomUUID()}.${safeFormat}`;

  const s3 = getUploadS3Client('b2');
  const bucket = getUploadBucket('b2');
  const endpoint = env.S3_UPLOAD_B2_ENDPOINT?.replace(/\/+$/, '');
  if (!bucket || !endpoint) {
    throw new Error(
      'Model upload bucket / endpoint not configured (S3_UPLOAD_B2_BUCKET, S3_UPLOAD_B2_ENDPOINT)'
    );
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: buffer,
      ContentType: contentTypeForFormat(safeFormat),
    })
  );

  // Path-style URL. `parseKey` / `parseB2Url` / `isB2Url` all key off the
  // configured B2 endpoint host, so consumers downstream (model3d.service
  // `getModel3DFiles`, the inline viewer, the download link) recognise it
  // as a B2 asset and sign against `getUploadBucket('b2')`.
  const fullUrl = `${endpoint}/${bucket}/${s3Key}`;

  return {
    format: safeFormat,
    url: fullUrl,
    sizeKB: buffer.length / 1024,
  };
}

/**
 * Ingest a PolyGen output thumbnail as a real `Image` row. The Image
 * goes through the standard scan pipeline (NSFW + CSAM) so the resulting
 * `Image.nsfwLevel` can be propagated up to `Model3D.nsfwLevel` by the
 * batch job in `nsfwLevels.service.ts`.
 *
 * Returns the new Image id, or undefined if the thumbnail couldn't be
 * downloaded (we still create the Model3D — the detail page falls back
 * to the source image / a placeholder).
 */
async function ingestThumbnailImage(
  thumbnail: ImageBlob,
  userId: number,
  workflowId: string
): Promise<number | undefined> {
  if (!thumbnail.url) return undefined;
  try {
    const response = await fetch(thumbnail.url);
    if (!response.ok) {
      logToAxiom({
        name: POLYGEN_LOG,
        type: 'warn',
        message: 'Failed to download polygen thumbnail',
        workflowId,
        status: response.status,
      }).catch(() => undefined);
      return undefined;
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    const s3Key = randomUUID();
    const { s3, bucket, backend } = await getImageUploadBackend();
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: buffer,
        ContentType: response.headers.get('content-type') || 'image/jpeg',
      })
    );
    registerMediaLocation(s3Key, backend, buffer.length);

    const image = await createImage({
      url: s3Key,
      type: 'image',
      userId,
      width: thumbnail.width ?? 512,
      height: thumbnail.height ?? 512,
      meta: { workflowId } as never,
    } as Parameters<typeof createImage>[0]);
    return image.id;
  } catch (e) {
    logToAxiom({
      name: POLYGEN_LOG,
      type: 'error',
      message: 'Failed to ingest polygen thumbnail',
      workflowId,
      error: e instanceof Error ? e.message : String(e),
    }).catch(() => undefined);
    return undefined;
  }
}

/** Best-guess Content-Type for the major 3D formats we'll see from Meshy. */
function contentTypeForFormat(format: string): string {
  switch (format) {
    case 'glb':
      return 'model/gltf-binary';
    case 'gltf':
      return 'model/gltf+json';
    case 'fbx':
      return 'application/octet-stream';
    case 'obj':
      return 'model/obj';
    case 'usdz':
      return 'model/vnd.usdz+zip';
    case 'stl':
      return 'model/stl';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Suggested file name for a Model3DFile row. Kept here (not in
 * model3d.service) so swap-in of the service layer doesn't change names.
 *
 * The primary variant keeps the historical `<wf>.<format>` shape so
 * existing files (uploaded before the variant column landed) stay
 * indistinguishable from a re-ingested primary. Non-primary variants
 * encode the variant into the filename so downloaded files don't
 * collide when an owner saves the whole bundle to disk.
 */
export function deriveFileName(
  workflowId: string,
  format: string,
  variant: string = 'primary'
): string {
  if (variant === 'primary') return `${workflowId}.${format}`;
  return `${workflowId}.${variant}.${format}`;
}

/** Re-export so consumers can pluck the constants without importing the helper. */
export { PRIMARY_FORMAT, POLYGEN_S3_PREFIX };

/**
 * Re-export the result shape under a Workflow alias so callers can pass
 * `Workflow.steps[0]` straight through without re-importing PolyGen types.
 */
export type PolyGenWorkflow = Workflow;
