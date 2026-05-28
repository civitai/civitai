/**
 * PolyGen Ecosystem Handler
 *
 * Submits PolyGen (Meshy via Fal) workflows for 3D model generation, and
 * processes the workflow result into a Draft `Model3D` row.
 *
 * Why a self-contained handler (not the `defineHandler` ecosystem pattern):
 * the ecosystem-handler factory routes off `data.ecosystem` and returns
 * `StepInput[]` to be bundled by `orchestration-new.service.ts`. PolyGen
 * is its own workflow with its own discriminated form schema and its own
 * post-processing (ingest thumbnail, copy 3D blobs, create Model3D draft),
 * so we expose two top-level functions:
 *
 *   - `submitPolyGenWorkflow`  — user submits the form; we enqueue the
 *     async workflow via `submitWorkflow`. Returns the orchestrator
 *     workflow id; the Draft Model3D is created later, in the result
 *     handler, not synchronously here.
 *   - `handlePolyGenWorkflowResult` — called when the workflow finishes
 *     (poll loop / webhook). Normalises blob formats, copies outputs to
 *     our S3 (`3d/` prefix), ingests the thumbnail as a real `Image`,
 *     and upserts the `Model3D` + `Model3DFile` rows. Idempotent on
 *     `Model3D.workflowId`.
 *
 * IMPORTANT: we explicitly do NOT call `invokePolyGenStepTemplate` —
 * that's the synchronous recipe-eval endpoint and bypasses the queue,
 * billing, and retry surfaces. See `docs/3d-models-plan.md` §2.2.
 *
 * Workstream-A dependency: the `Model3D` service (`upsertModel3DDraft`,
 * etc.) is being built in parallel. Where this file needs those calls
 * it has a TODO with the expected signature and uses a small adapter
 * stub so the file compiles. When workstream A lands, swap the stub for
 * the real import.
 */

import type {
  ImageBlob,
  MeshyImageTo3dFalPolyGenInput,
  MeshyTextTo3dFalPolyGenInput,
  Model3dBlob,
  PolyGenOutput,
  PolyGenStepTemplate,
  Workflow,
} from '@civitai/client';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { logToAxiom } from '~/server/logging/client';
import {
  toMeshyPolyGenInput,
  type Model3DGenerationSchema,
} from '~/server/orchestrator/polygen/polygen.schema';
import { submitWorkflow } from '~/server/services/orchestrator/workflows';
import { createImage } from '~/server/services/image.service';
import { upsertModel3DFromWorkflow } from '~/server/services/model3d.service';
import { registerMediaLocation } from '~/server/services/storage-resolver';
import { getImageUploadBackend } from '~/utils/s3-utils';
import type { Prisma } from '@prisma/client';

// =============================================================================
// Constants
// =============================================================================

const POLYGEN_S3_PREFIX = '3d/';
const PRIMARY_FORMAT = 'glb';
const POLYGEN_LOG = 'polygen-handler';

// =============================================================================
// Submission
// =============================================================================

export type SubmitPolyGenArgs = {
  /** Validated form input — output of `model3dGenerationSchema.parse(...)` */
  data: Model3DGenerationSchema;
  /** Orchestrator-scoped auth token for the submitting user */
  token: string;
  /** The Civitai user id submitting the workflow (for downstream linkage) */
  userId: number;
  /** Whether to allow mature outputs (passed through to orchestrator). */
  allowMatureContent?: boolean;
  /** Optional pre-ingested source image id (image-to-3D only). */
  sourceImageId?: number;
};

/**
 * Build a `PolyGenStep` for the workflow body. Exported for tests +
 * for whatif/cost-preview callers that need just the step shape.
 */
export function buildPolyGenStep(data: Model3DGenerationSchema): PolyGenStepTemplate {
  const input = toMeshyPolyGenInput(data) as
    | MeshyTextTo3dFalPolyGenInput
    | MeshyImageTo3dFalPolyGenInput;
  return {
    $type: 'polyGen',
    input,
  } as PolyGenStepTemplate;
}

/**
 * Submit a PolyGen workflow to the orchestrator. Returns the orchestrator's
 * Workflow object (contains `id` — surface this to the queue UI and persist
 * onto the Draft Model3D when the result handler runs).
 */
export async function submitPolyGenWorkflow({
  data,
  token,
  userId,
  allowMatureContent,
}: SubmitPolyGenArgs) {
  const step = buildPolyGenStep(data);

  // Match the workflow-tagging shape used elsewhere (orchestration-new.service.ts).
  const tags = [
    'generation',
    'model3d',
    'polyGen',
    'meshy',
    data.process,
  ];

  // Pass through the userId in metadata so the result handler can link
  // the created Model3D draft back to the originator without a second
  // round-trip.
  const metadata: Record<string, unknown> = {
    type: 'model3d',
    process: data.process,
    userId,
  };

  const workflow = await submitWorkflow({
    token,
    body: {
      tags,
      // Cast to satisfy WorkflowStepTemplate[] — PolyGenStepTemplate is a
      // valid concrete subtype but the registry type is the union of all
      // known step templates and doesn't include PolyGen explicitly in
      // every place the codebase narrows.
      steps: [step] as unknown as PolyGenStepTemplate[],
      metadata,
      allowMatureContent,
      currencies: [], // PolyGen pricing comes from the orchestrator whatIf; no per-workflow currency restriction
    },
  });

  return workflow;
}

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
  // 1. Collect + normalize the 3D blobs (model + optional fbxModel)
  // ---------------------------------------------------------------------------
  const blobs: { format: string; blob: Model3dBlob }[] = [];
  if (output.model) {
    blobs.push({ format: normalizeFormat(output.model.format), blob: output.model });
  }
  if (output.fbxModel) {
    blobs.push({ format: normalizeFormat(output.fbxModel.format), blob: output.fbxModel });
  }

  if (blobs.length === 0) {
    throw new Error(`PolyGen workflow ${workflowId} produced no model blobs`);
  }

  // ---------------------------------------------------------------------------
  // 2. Copy each model blob into our S3 (`3d/<uuid>.<format>`)
  // ---------------------------------------------------------------------------
  const copiedFiles: CopiedModelFile[] = [];
  for (const { format, blob } of blobs) {
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
      }).catch(() => undefined);
      continue;
    }
    copiedFiles.push(copied);
  }

  if (copiedFiles.length === 0) {
    throw new Error(
      `PolyGen workflow ${workflowId} had blobs but none could be copied to S3`
    );
  }

  // ---------------------------------------------------------------------------
  // 3. Ingest the thumbnail image (if any) into the standard Image pipeline
  // ---------------------------------------------------------------------------
  let thumbnailImageId: number | undefined;
  if (output.thumbnail) {
    thumbnailImageId = await ingestThumbnailImage(output.thumbnail, userId, workflowId);
  }

  // ---------------------------------------------------------------------------
  // 4. Upsert the Model3D draft row + Model3DFile rows (idempotent on workflowId)
  // ---------------------------------------------------------------------------
  const { id, created } = await upsertModel3DFromWorkflow({
    workflowId,
    userId,
    thumbnailImageId,
    sourceImageId,
    licenseId,
    generationParams: generationParams as Prisma.InputJsonValue,
    files: copiedFiles.map(({ url, format, sizeKB }) => ({
      name: deriveFileName(workflowId, format),
      url,
      format,
      sizeKB,
      isPrimary: format === PRIMARY_FORMAT,
    })),
  });

  logToAxiom({
    name: POLYGEN_LOG,
    type: 'info',
    message: created ? 'PolyGen Model3D draft created' : 'PolyGen Model3D draft already exists (idempotent)',
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
  return String(format ?? '').toLowerCase().replace(/^\./, '');
}

/** A model3d blob that has been copied to our S3, ready for a Model3DFile row. */
type CopiedModelFile = {
  format: string;
  /** S3 key (the `Model3DFile.url` column stores this) */
  url: string;
  /** File size in kilobytes (Model3DFile.sizeKB) */
  sizeKB: number;
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

  const { s3, bucket, backend } = await getImageUploadBackend();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      Body: buffer,
      ContentType: contentTypeForFormat(safeFormat),
    })
  );
  registerMediaLocation(s3Key, backend, buffer.length);

  return {
    format: safeFormat,
    url: s3Key,
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
 */
export function deriveFileName(workflowId: string, format: string): string {
  return `${workflowId}.${format}`;
}

/** Re-export so consumers can pluck the constants without importing the helper. */
export { PRIMARY_FORMAT, POLYGEN_S3_PREFIX };

/**
 * Re-export the result shape under a Workflow alias so callers can pass
 * `Workflow.steps[0]` straight through without re-importing PolyGen types.
 */
export type PolyGenWorkflow = Workflow;
