import { TRPCError } from '@trpc/server';
import type { Workflow, WorkflowStatus } from '@civitai/client';
import { dbRead } from '~/server/db/client';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';
import type {
  BlockWorkflowBody,
  BlockWorkflowSnapshot,
} from '~/server/schema/blocks/workflow.schema';
import type { GenerateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';

// Per-family default checkpoint the host prepends to a block's resources
// when the block's bound model isn't itself a Checkpoint (e.g. a LoRA).
// Without an anchor Checkpoint the orchestrator rejects the workflow.
//
// v1 is intentionally narrow — only Flux1 is wired. Filling in SDXL/SD1/etc.
// requires picking a "canonical" platform checkpoint for each family, which
// is a product decision (which model gets attribution? what's the buzz
// profile?). LoRAs from un-mapped families return BAD_REQUEST with a clear
// message until the table grows.
const DEFAULT_CHECKPOINT_VERSION_BY_FAMILY: Record<string, number | undefined> = {
  // urn:air:flux1:checkpoint:civitai:618692@691639 — fluxStandardAir
  Flux1: 691639,
};

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
    workflowId: workflow.id ?? '',
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
 */
export function buildTextToImageInput(
  body: Extract<BlockWorkflowBody, { kind: 'textToImage' }>,
  resolved: { baseModel: string; modelType: string }
): GenerateImageSchema {
  const dims = defaultDimensions(resolved.baseModel);
  const width = body.params.width ?? dims.width;
  const height = body.params.height ?? dims.height;

  // Orchestrator requires a Checkpoint in resources to anchor the run.
  // If the block's bound model is itself a Checkpoint, that's it. Otherwise
  // (LoRA, LyCORIS, embedding) prepend the platform's per-family default —
  // Flux1 only in v1, per DEFAULT_CHECKPOINT_VERSION_BY_FAMILY.
  const resources: Array<{ id: number; strength: number }> = [];
  if (resolved.modelType !== 'Checkpoint') {
    const family = getBaseModelSetType(resolved.baseModel);
    const fallback = DEFAULT_CHECKPOINT_VERSION_BY_FAMILY[family];
    if (!fallback) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          `Blocks v1 has no default checkpoint configured for base model "${resolved.baseModel}". ` +
          `Only Flux LoRAs are supported at this time.`,
      });
    }
    resources.push({ id: fallback, strength: 1 });
  }
  resources.push({ id: body.modelVersionId, strength: 1 });

  return {
    params: {
      prompt: body.params.prompt,
      negativePrompt: body.params.negativePrompt,
      cfgScale: body.params.cfgScale,
      sampler: body.params.sampler ?? 'Euler',
      steps: body.params.steps ?? 25,
      seed: body.params.seed ?? null,
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
