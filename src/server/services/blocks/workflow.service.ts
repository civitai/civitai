import { TRPCError } from '@trpc/server';
import type { Workflow, WorkflowStatus } from '@civitai/client';
import { dbRead } from '~/server/db/client';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';
import type {
  BlockWorkflowBody,
  BlockWorkflowSnapshot,
} from '~/server/schema/blocks/workflow.schema';
import type { GenerateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';

// Map orchestrator-internal states the block contract doesn't expose to the
// closest publicly-modeled status. `unassigned`/`preparing`/`scheduled` are
// all "queued but not running" to the user; `processing` is the public name.
const ORCH_STATUS_MAP: Record<WorkflowStatus, BlockWorkflowSnapshot['status']> = {
  unassigned: 'pending',
  preparing: 'pending',
  scheduled: 'pending',
  processing: 'processing',
  succeeded: 'succeeded',
  failed: 'failed',
  expired: 'expired',
  canceled: 'canceled',
};

/**
 * Flatten an orchestrator Workflow into the wire-stable shape the iframe
 * receives. Only image URLs that are `available` and have a non-null url are
 * surfaced — pending/blocked blobs are dropped rather than sending dead links
 * the block would render as broken images.
 */
export function snapshotFromWorkflow(workflow: Workflow): BlockWorkflowSnapshot {
  const status = ORCH_STATUS_MAP[workflow.status] ?? 'pending';
  const imageUrls: string[] = [];
  for (const step of workflow.steps ?? []) {
    if (step.$type !== 'textToImage' && step.$type !== 'imageGen' && step.$type !== 'comfy') {
      continue;
    }
    const stepOutput = (
      step as unknown as {
        output?: { images?: Array<{ url?: string | null; available?: boolean }> };
      }
    ).output;
    for (const img of stepOutput?.images ?? []) {
      if (img.available && typeof img.url === 'string' && img.url.length > 0) {
        imageUrls.push(img.url);
      }
    }
  }
  const total = workflow.cost?.total;
  return {
    // A whatif/estimate workflow has no orchestrator id. The block SDK's
    // inbound validator (isValidWorkflowSnapshot) DROPS any snapshot whose
    // workflowId is an empty string, so an `''` here silently strands the
    // ESTIMATE_RESULT reply until the 120s transport timeout (the block then
    // falls back to a "≤ budget" cost). Emit a non-empty sentinel so estimate
    // replies validate; the block treats estimate results as a cost quote only
    // and never polls on this id (the request is correlated by requestId, not
    // workflowId). Submit always carries a real id, so it is unaffected.
    workflowId: workflow.id ?? 'whatif',
    status,
    ...(typeof total === 'number' ? { cost: { total } } : {}),
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
  };
}

/**
 * Resolve a modelVersionId to the platform-side fields the block doesn't
 * know: model row, baseModel string, model type. Returns a 404 TRPCError if
 * the version is missing or unpublished — never reveals whether the row
 * exists for a different model.
 */
export async function resolveBlockVersionContext(modelVersionId: number, expectedModelId: number) {
  const version = await dbRead.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: {
      id: true,
      baseModel: true,
      modelId: true,
      status: true,
      model: { select: { id: true, type: true } },
    },
  });
  if (!version || version.status !== 'Published') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'model version not found' });
  }
  // Context binding mirror: the block JWT pins modelId; the modelVersionId
  // the block submits must belong to that same model. Without this a block
  // installed on model A could spend its budget on a generation attributed
  // to model B (e.g. by sending a versionId from B's lineage).
  if (version.modelId !== expectedModelId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'modelVersionId does not belong to the bound model',
    });
  }
  return {
    modelId: version.modelId,
    modelVersionId: version.id,
    baseModel: version.baseModel,
    modelType: version.model.type,
  };
}

/**
 * Default canvas dimensions per base-model family. Aligned with what the
 * generation form picks when a user hits "Generate" with no overrides —
 * SDXL/Flux-class models train at 1024², SD1/SD2 at 512².
 */
function defaultDimensions(baseModel: string): { width: number; height: number } {
  const group = getBaseModelSetType(baseModel);
  switch (group) {
    case 'SD1':
    case 'SD2':
      return { width: 512, height: 512 };
    default:
      return { width: 1024, height: 1024 };
  }
}

/**
 * Translate the block's narrow body into the platform's `generateImageSchema`
 * shape. Defaults are intentionally conservative — matches the comics-router
 * preset (sampler=Euler, steps=25, priority=low) so block submissions and
 * platform submissions share the same orchestrator cost profile.
 *
 * `checkpointVersionId` is now the caller's responsibility (passed by the
 * router after `resolveBlockCheckpoint`). For Checkpoint-bound installs the
 * resolver returns `body.modelVersionId` here, so the resources array has
 * exactly one entry — the model is its own anchor. For LoRA installs the
 * resolver returns a different versionId; we prepend that as the anchor
 * and push the LoRA after it.
 */
export function buildTextToImageInput(
  body: Extract<BlockWorkflowBody, { kind: 'textToImage' }>,
  resolved: { baseModel: string; modelType: string; checkpointVersionId: number }
): GenerateImageSchema {
  const dims = defaultDimensions(resolved.baseModel);
  const width = body.params.width ?? dims.width;
  const height = body.params.height ?? dims.height;

  const resources: Array<{ id: number; strength: number }> = [
    { id: resolved.checkpointVersionId, strength: 1 },
  ];
  // Avoid duplicating the same versionId on both sides when the model is
  // itself the anchor — that would double-bill the resource and double-
  // count strength.
  if (resolved.modelType !== 'Checkpoint') {
    resources.push({ id: body.modelVersionId, strength: 1 });
  }

  return {
    params: {
      prompt: body.params.prompt,
      negativePrompt: body.params.negativePrompt,
      cfgScale: body.params.cfgScale,
      sampler: body.params.sampler ?? 'Euler',
      steps: body.params.steps ?? 25,
      seed: body.params.seed ?? null,
      // Per-resource clipSkip carried from the showcase image's meta.
      // Flux pipelines ignore it; SD1/SDXL graphs apply it at the
      // CLIP-encoder node. Omit when not set so the platform uses its
      // default rather than 0 (which would skip no layers in some graphs).
      ...(body.params.clipSkip != null ? { clipSkip: body.params.clipSkip } : {}),
      quantity: body.params.quantity,
      baseModel: resolved.baseModel,
      width,
      height,
      workflow: 'txt2img',
      draft: false,
      disablePoi: false,
      priority: 'low',
      sourceImage: null,
    },
    resources,
    tags: [],
    tips: { creators: 0, civitai: 0 },
  } as unknown as GenerateImageSchema;
}
