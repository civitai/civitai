import { TRPCError } from '@trpc/server';
import type { Workflow, WorkflowStatus } from '@civitai/client';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
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
  const spentAccountType = primaryDebitedAccountType(workflow.transactions);
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
    // Surface the realized spent account (money page blocks). Additive +
    // optional — omitted when there's no debit to report so every existing
    // snapshot stays byte-identical to before.
    ...(spentAccountType ? { spentAccountType } : {}),
  };
}

// The three spendable buzz accounts a snapshot surfaces. `fakeRed` is
// disabled/internal and never a real spend; credits and any other account type
// are not reported.
const SNAPSHOT_SPENDABLE_ACCOUNTS: ReadonlySet<string> = new Set<BuzzSpendType>([
  'blue',
  'green',
  'yellow',
]);

/**
 * The buzz account that PRIMARILY funded a generation — the accountType of the
 * largest realized `debit` on the orchestrator's `transactions.list`. A single
 * generation can split across free (blue) and paid (green/yellow) buzz; we
 * report the account with the biggest debit as the primary funder. Returns
 * `undefined` when there are no debits (estimate / cache-hit / no-transactions
 * snapshot) or the largest debit is an internal-only account (fakeRed), so the
 * field is simply omitted rather than leaking a non-spendable type.
 */
function primaryDebitedAccountType(
  transactions: Workflow['transactions']
): BuzzSpendType | undefined {
  const debits = (transactions?.list ?? []).filter((t) => t.type === 'debit');
  if (debits.length === 0) return undefined;
  const largest = debits.reduce((a, b) =>
    Math.abs(b.amount ?? 0) > Math.abs(a.amount ?? 0) ? b : a
  );
  return SNAPSHOT_SPENDABLE_ACCOUNTS.has(largest.accountType)
    ? (largest.accountType as BuzzSpendType)
    : undefined;
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

// ── Bounded image-workflow allowlist (App Blocks IMAGE bridge, Phase-2a) ─────
// The block bridge maps an untrusted block body into a generation-graph input.
// This phase deliberately produces ONLY image graph workflows. The workflow
// type is a validated value (checked against this allowlist), never a
// hardcoded literal — so a body can never drive the block bridge into a
// non-image graph workflow.
//
// EXTENDING to a new media class later (video/audio/3D) is additive and does
// NOT require a rewrite: (1) add the graph workflow key(s) here, (2) add a
// per-type param-mapping branch in buildImageWorkflowInput below (its own
// bounded validator for that class's params), and (3) add the corresponding
// discriminated-union `kind` in workflow.schema. Everything else — the
// resource fan-out, the router's per-item entitlement gate, the LoRA gate, the
// budget preflight — is workflow-type-agnostic and stays as-is.
export const BLOCK_IMAGE_WORKFLOW_TYPES = ['txt2img', 'img2img'] as const;
export type BlockImageWorkflowType = (typeof BLOCK_IMAGE_WORKFLOW_TYPES)[number];

function isBlockImageWorkflowType(workflow: string): workflow is BlockImageWorkflowType {
  return (BLOCK_IMAGE_WORKFLOW_TYPES as readonly string[]).includes(workflow);
}

/**
 * Resolve which image graph workflow a block body maps to: `img2img` when a
 * bounded source/init image is present (image variations), else `txt2img`.
 * Purely structural — the schema already validated/bounded `sourceImage`.
 */
export function resolveBlockImageWorkflowType(
  body: Extract<BlockWorkflowBody, { kind: 'textToImage' }>
): BlockImageWorkflowType {
  return body.sourceImage ? 'img2img' : 'txt2img';
}

/**
 * Translate the block's narrow body into the platform's generation-graph
 * `input` (the flat `Record<string, unknown>` shape `generateFromGraph` /
 * `createWorkflowStepsFromGraphInput` consume), for the IMAGE workflow class
 * (txt2img / img2img). Defaults are intentionally conservative — matches the
 * comics-router preset (sampler=Euler, steps=25, priority=low) so block
 * submissions and platform submissions share the same orchestrator cost profile.
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
 * WORKFLOW TYPE: `workflowType` defaults to the type derived from the body
 * (`sourceImage` presence → img2img, else txt2img) and is VALIDATED against
 * BLOCK_IMAGE_WORKFLOW_TYPES — a non-image type is rejected fail-closed with a
 * BAD_REQUEST rather than silently producing a workflow this phase does not
 * support. The explicit parameter is the seam a later phase / an explicit-type
 * body flows through; the router passes nothing and gets the derived type.
 *
 * DIMENSIONS: for txt2img the graph's `aspectRatio` node snaps the block-supplied
 * width/height to the ecosystem's nearest canonical bucket (the block sends
 * arbitrary 64–2048 dims from untrusted iframe UI). For img2img the graph derives
 * output dimensions from the source image, so aspectRatio is omitted.
 */
export function buildImageWorkflowInput(
  body: Extract<BlockWorkflowBody, { kind: 'textToImage' }>,
  resolved: {
    baseModel: string;
    modelType: string;
    checkpointVersionId: number;
    checkpointBaseModel: string;
  },
  workflowType: string = resolveBlockImageWorkflowType(body)
): Record<string, unknown> {
  if (!isBlockImageWorkflowType(workflowType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `unsupported block workflow type '${workflowType}' — only image workflows (${BLOCK_IMAGE_WORKFLOW_TYPES.join(
        ', '
      )}) are supported`,
    });
  }
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

  const input: Record<string, unknown> = {
    workflow: workflowType,
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
    quantity: body.params.quantity,
    priority: 'low',
  };

  if (workflowType === 'img2img') {
    // img2img (SD-family image variations): the graph's `images` node is the
    // init image; the denoise node applies at its default strength (0.75), and
    // the graph derives output dimensions from the source image — so aspectRatio
    // is OMITTED here (the SD graph gates aspectRatio to `when: !hasImages`).
    // `sourceImage` is guaranteed present here (resolveBlockImageWorkflowType
    // only returns 'img2img' when the body carries one); the fallback keeps the
    // types honest for an explicit-type caller. The graph's imagesNode reads
    // { url, width, height }; extra fields are stripped by its object parse.
    if (body.sourceImage) {
      input.images = [
        {
          url: body.sourceImage.url,
          width: body.sourceImage.width,
          height: body.sourceImage.height,
        },
      ];
    }
    return input;
  }

  // txt2img: the aspectRatio node accepts { value, width, height } and snaps to
  // the nearest bucket by dimensions — see the DIMENSIONS note above.
  input.aspectRatio = { value: `${width}:${height}`, width, height };
  return input;
}

// Back-compat alias. Existing router call sites + tests reference
// `buildTextToImageInput`; it is now the IMAGE-class builder (txt2img when the
// body has no source image — byte-identical to before — img2img when it does).
export const buildTextToImageInput = buildImageWorkflowInput;
