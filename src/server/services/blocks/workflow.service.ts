import { TRPCError } from '@trpc/server';
import type { Workflow, WorkflowStatus } from '@civitai/client';
import { dbRead } from '~/server/db/client';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';
import { getEcosystem } from '~/shared/constants/basemodel.constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import type {
  BlockWorkflowBody,
  BlockWorkflowSnapshot,
} from '~/server/schema/blocks/workflow.schema';

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
      // W10 generation spend: the extra fields below feed
      // `resolveCanGenerateForVersions` so the PAGE branch in blocks.router can
      // gate a viewer-picked model through the platform's canonical generation-
      // entitlement check (early-access / availability / coverage / members-
      // only). They are additive — the MODEL slot path never reads `gate`, so
      // its behaviour is byte-identical to before this select grew.
      availability: true,
      usageControl: true,
      meta: true,
      generationCoverage: { select: { covered: true } },
      model: { select: { id: true, type: true, userId: true } },
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
    // The fields `resolveCanGenerateForVersions` needs, shaped as
    // `ResolveCanGenerateVersion` so the page branch can pass it straight
    // through. `modelVersionAlias` is read from the version meta exactly as the
    // standard generation read paths (model-version.controller) do.
    gate: {
      id: version.id,
      status: version.status,
      availability: version.availability,
      usageControl: version.usageControl,
      baseModel: version.baseModel,
      covered: version.generationCoverage?.covered ?? false,
      modelUserId: version.model.userId,
      modelType: version.model.type,
      modelVersionAlias:
        (version.meta as { generationAlias?: unknown } | null)?.generationAlias ?? null,
    },
  };
}

// Page-LoRA (Increment 1): the model types accepted as a page additional
// resource. v1 is LoRA-only — the generator's LoRA family is LORA + LoCon +
// DoRA (the same set the generation resource picker groups as "LoRA"; see
// base-model.constants supportMap). VAE / embeddings / etc. also flow through
// the same `resources` array + belt but are deferred to a later increment.
export const PAGE_LORA_MODEL_TYPES: ReadonlySet<string> = new Set([
  ModelType.LORA,
  ModelType.LoCon,
  ModelType.DoRA,
]);

export function isPageLoraResource(modelType: string): boolean {
  return PAGE_LORA_MODEL_TYPES.has(modelType);
}

/**
 * Page-LoRA (Increment 1, Option A): resolve a bare modelVersionId for a
 * STATELESS page — identical select to `resolveBlockVersionContext` but WITHOUT
 * the `version.modelId !== expectedModelId` FORBIDDEN binding check, because a
 * page token has no JWT model binding (the viewer picks any resource they're
 * entitled to; the security boundary is the per-resource entitlement gate in
 * blocks.router, not a binding check).
 *
 * Do NOT route page LoRAs through `resolveBlockCheckpoint` — that helper is
 * checkpoint-shaped (it asserts `modelType === 'Checkpoint'` and reads install
 * rows a stateless page has none of). This returns the same `gate` bag +
 * baseModel + modelType the checkpoint path already returns, so the router can
 * (a) reject non-LoRA additional resources, (b) family-match against the
 * checkpoint, and (c) entitlement-gate every resource in one call.
 *
 * Like the checkpoint resolver it throws NOT_FOUND for a missing/unpublished
 * version and never reveals which model a hidden version belongs to.
 */
export async function resolvePageResourceContext(modelVersionId: number) {
  const version = await dbRead.modelVersion.findUnique({
    where: { id: modelVersionId },
    select: {
      id: true,
      baseModel: true,
      modelId: true,
      status: true,
      availability: true,
      usageControl: true,
      meta: true,
      generationCoverage: { select: { covered: true } },
      model: { select: { id: true, type: true, userId: true } },
    },
  });
  if (!version || version.status !== 'Published') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'model version not found' });
  }
  return {
    modelId: version.modelId,
    modelVersionId: version.id,
    baseModel: version.baseModel,
    modelType: version.model.type,
    gate: {
      id: version.id,
      status: version.status,
      availability: version.availability,
      usageControl: version.usageControl,
      baseModel: version.baseModel,
      covered: version.generationCoverage?.covered ?? false,
      modelUserId: version.model.userId,
      modelType: version.model.type,
      modelVersionAlias:
        (version.meta as { generationAlias?: unknown } | null)?.generationAlias ?? null,
    },
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
 * Translate the block's narrow body into the platform's generation-graph
 * `input` (the flat `Record<string, unknown>` shape `generateFromGraph` /
 * `createWorkflowStepsFromGraphInput` consume). Defaults are intentionally
 * conservative — matches the comics-router preset (sampler=Euler, steps=25,
 * priority=low) so block submissions and platform submissions share the same
 * orchestrator cost profile.
 *
 * Migrated off the deleted legacy `createTextToImageStep` path (which consumed
 * the old `{ params, resources }` `GenerateImageSchema`). The new graph
 * pipeline owns resource enrichment, AIR resolution, canGenerate/availability
 * gating, and POI — so this only has to produce a valid graph input.
 *
 * Resource model:
 *   - `model` is the CHECKPOINT (the graph's anchor); `resources` are the
 *     additional networks (LoRAs). This is the graph's split — distinct from
 *     the old shape, which put the checkpoint at `resources[0]`.
 *   - `ecosystem` is derived from the CHECKPOINT's baseModel (`checkpointBaseModel`),
 *     NOT the bound model's — for a non-Checkpoint install the resolver picks a
 *     default checkpoint that may belong to a different base-model family.
 *
 * `checkpointVersionId` / `checkpointBaseModel` are the caller's responsibility
 * (passed by the router after `resolveBlockCheckpoint`). For Checkpoint-bound
 * installs both describe `body.modelVersionId` and `resources` is empty (the
 * model is its own anchor). For LoRA installs the resolver returns a different
 * checkpoint; the bound LoRA is pushed into `resources`.
 *
 * DIMENSIONS: the graph's `aspectRatio` node snaps the block-supplied
 * width/height to the ecosystem's nearest canonical bucket (the block sends
 * arbitrary 64–2048 dims from untrusted iframe UI). This is a deliberate
 * behavior change from the deleted path, which passed exact dims through — the
 * orchestrator prefers canonical dims and the main generator already snaps.
 */
export function buildTextToImageInput(
  body: Extract<BlockWorkflowBody, { kind: 'textToImage' }>,
  resolved: {
    baseModel: string;
    modelType: string;
    checkpointVersionId: number;
    checkpointBaseModel: string;
  }
): Record<string, unknown> {
  const dims = defaultDimensions(resolved.checkpointBaseModel);
  const width = body.params.width ?? dims.width;
  const height = body.params.height ?? dims.height;

  // LoRAs only — the checkpoint is the `model` anchor, not a `resources` entry.
  const resources: Array<{ id: number; strength: number }> = [];
  // The bound model is itself a LoRA (LoRA install) — push it as a network.
  // A Checkpoint-bound install has no additional network here.
  if (resolved.modelType !== 'Checkpoint') {
    resources.push({ id: body.modelVersionId, strength: 1 });
  }

  // Page-LoRA (Increment 1): fan each caller-supplied additional resource into
  // `resources` as { id, strength }. DEDUPE against the checkpoint anchor AND
  // the bound-model network already present so a LoRA that coincides with the
  // anchor isn't double-billed / double-counted in strength. A LoRA that
  // duplicates another LoRA keeps its first occurrence (first-wins).
  if (body.additionalResources?.length) {
    const seen = new Set<number>([resolved.checkpointVersionId, ...resources.map((r) => r.id)]);
    for (const r of body.additionalResources) {
      if (seen.has(r.modelVersionId)) continue;
      seen.add(r.modelVersionId);
      resources.push({ id: r.modelVersionId, strength: r.strength });
    }
  }

  // Ecosystem drives the graph's branch + resource enrichment. Fall back to
  // SDXL (the graph's ultimate fallback) if the checkpoint's baseModel is
  // unrecognized — the resource belt will still gate it.
  const ecosystem = getEcosystem(resolved.checkpointBaseModel)?.key ?? 'SDXL';

  return {
    workflow: 'txt2img',
    ecosystem,
    model: { id: resolved.checkpointVersionId },
    resources,
    prompt: body.params.prompt,
    ...(body.params.negativePrompt != null ? { negativePrompt: body.params.negativePrompt } : {}),
    ...(body.params.cfgScale != null ? { cfgScale: body.params.cfgScale } : {}),
    sampler: body.params.sampler ?? 'Euler',
    steps: body.params.steps ?? 25,
    ...(body.params.seed != null ? { seed: body.params.seed } : {}),
    // Per-resource clipSkip carried from the showcase image's meta. Flux
    // pipelines have no clipSkip node (silently ignored); SD1/SDXL apply it at
    // the CLIP-encoder node. Omit when not set so the ecosystem uses its default.
    ...(body.params.clipSkip != null ? { clipSkip: body.params.clipSkip } : {}),
    // The aspectRatio node accepts { value, width, height } and snaps to the
    // nearest bucket by dimensions — see the DIMENSIONS note above.
    aspectRatio: { value: `${width}:${height}`, width, height },
    quantity: body.params.quantity,
    priority: 'low',
  };
}
