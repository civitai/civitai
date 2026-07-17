import { TRPCError } from '@trpc/server';
import type { CustomComfyStepTemplate, Workflow, WorkflowStatus } from '@civitai/client';
import type { AnyBlockRecipe, CustomComfyStepInput, ResolvedRecipeResources } from './recipes';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { dbRead } from '~/server/db/client';
import { nsfwLevelFromContentRating } from '~/shared/constants/browsingLevel.constants';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';
import { getEcosystem } from '~/shared/constants/basemodel.constants';
import { isWorkflowAvailable } from '~/shared/data-graph/generation/config/workflows';
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
    // A `customComfy` step (App Blocks customComfy bridge) surfaces its outputs
    // as `output.blobs` (CustomComfyOutput), NOT `output.images` — so it needs
    // its own extraction, otherwise its rendered panorama is silently dropped.
    if (step.$type === 'customComfy') {
      const blobs = (
        step as unknown as { output?: { blobs?: Array<{ url?: string | null; available?: boolean }> } }
      ).output?.blobs;
      for (const blob of blobs ?? []) {
        if (blob.available && typeof blob.url === 'string' && blob.url.length > 0) {
          imageUrls.push(blob.url);
        }
      }
      continue;
    }
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

/**
 * The per-APP "subqueue" tag. Every app-submitted workflow is server-stamped
 * with this tag at submit (`buildWorkflowTags` in blocks.router), so a POSITIVE
 * `tags:['app-block:<appId>']` filter on the orchestrator LIST returns exactly
 * the calling app's own generations — never the user's personal queue.
 *
 * SINGLE SOURCE OF TRUTH: the submit-time STAMP and the read-time FILTER both
 * call this, so the tag format can never silently desync (a mismatch would make
 * the subqueue read return an empty list forever, or — worse if the read hard-
 * coded a looser prefix — widen it). `appId` is always the OauthClient.id read
 * from the VERIFIED block token, never client input.
 */
export function appBlockTag(appId: string): string {
  return `app-block:${appId}`;
}

/**
 * The clean, wire-stable projection of an orchestrator Workflow the App Blocks
 * generator SUBQUEUE read (`blocks.queryAppWorkflows`) hands to a block. This is
 * the CONTRACT the SDK matches — keep it minimal + additive-only. It deliberately
 * DROPS every internal/sensitive workflow field (steps, params, prompts,
 * resources, tokens, transactions, metadata, tags) so a block can never read
 * generation internals of a queue it only owns by tag.
 *
 *   images: only blobs that are `available` with a non-null url are surfaced —
 *           pending/blocked/expired blobs are dropped rather than handing the
 *           block dead links (mirrors `snapshotFromWorkflow`). `width`/`height`
 *           are null when the orchestrator hasn't populated them. `nsfwLevel` is
 *           the numeric civitai browsing-level bitflag (1/2/4/8/16) mapped from
 *           the orchestrator's string rating; `null` for an unrated ('na') blob.
 *   cost:   the workflow's realized/estimated buzz total, or null when absent.
 *   status: the block-contract status (see ORCH_STATUS_MAP) — the orchestrator's
 *           unassigned/preparing/scheduled all collapse to `pending`.
 */
export type AppWorkflowImage = {
  url: string;
  width: number | null;
  height: number | null;
  nsfwLevel: number | null;
};
export type AppWorkflow = {
  workflowId: string;
  status: BlockWorkflowSnapshot['status'];
  images: AppWorkflowImage[];
  cost: number | null;
  createdAt: string;
};

/**
 * Pure projection Workflow → AppWorkflow. No IO, no throws — safe to map over a
 * whole page of LIST results. See `AppWorkflow` for the field-by-field contract.
 */
export function projectAppWorkflow(workflow: Workflow): AppWorkflow {
  const status = ORCH_STATUS_MAP[workflow.status] ?? 'pending';
  const images: AppWorkflowImage[] = [];
  for (const step of workflow.steps ?? []) {
    // A `customComfy` step surfaces its outputs as `output.blobs`
    // (CustomComfyOutput) — no width/height, `nsfwLevel` is the same string
    // rating the image steps carry. Extract it here so the app subqueue read
    // picks up recipe-generated images (mirrors the snapshotFromWorkflow branch).
    if (step.$type === 'customComfy') {
      const blobs = (
        step as unknown as {
          output?: {
            blobs?: Array<{ url?: string | null; available?: boolean; nsfwLevel?: string | null }>;
          };
        }
      ).output?.blobs;
      for (const blob of blobs ?? []) {
        if (!blob.available || typeof blob.url !== 'string' || blob.url.length === 0) continue;
        images.push({
          url: blob.url,
          width: null,
          height: null,
          nsfwLevel:
            blob.nsfwLevel && blob.nsfwLevel !== 'na'
              ? nsfwLevelFromContentRating(blob.nsfwLevel)
              : null,
        });
      }
      continue;
    }
    if (step.$type !== 'textToImage' && step.$type !== 'imageGen' && step.$type !== 'comfy') {
      continue;
    }
    const stepOutput = (
      step as unknown as {
        output?: {
          images?: Array<{
            url?: string | null;
            available?: boolean;
            width?: number | null;
            height?: number | null;
            nsfwLevel?: string | null;
          }>;
        };
      }
    ).output;
    for (const img of stepOutput?.images ?? []) {
      if (!img.available || typeof img.url !== 'string' || img.url.length === 0) continue;
      images.push({
        url: img.url,
        width: typeof img.width === 'number' ? img.width : null,
        height: typeof img.height === 'number' ? img.height : null,
        // Map the orchestrator's string rating to the numeric civitai browsing-
        // level bitflag via the CANONICAL helper (handles the SFW 'g' the raw map
        // lacks + all of pg/pg13/r/x/xxx, fail-closed to PG for an unexpected
        // string — so it can't drift from the platform mapping). null ONLY for the
        // genuinely-unrated sentinel ('na') / unset.
        nsfwLevel:
          img.nsfwLevel && img.nsfwLevel !== 'na'
            ? nsfwLevelFromContentRating(img.nsfwLevel)
            : null,
      });
    }
  }
  const total = workflow.cost?.total;
  return {
    // A real LIST/GET item always carries an id; empty-string only if the
    // orchestrator ever omits it (never for a persisted workflow).
    workflowId: workflow.id ?? '',
    status,
    images,
    cost: typeof total === 'number' ? total : null,
    createdAt: workflow.createdAt,
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
export const BLOCK_IMAGE_WORKFLOW_TYPES = ['txt2img', 'img2img', 'img2img:edit'] as const;
export type BlockImageWorkflowType = (typeof BLOCK_IMAGE_WORKFLOW_TYPES)[number];

function isBlockImageWorkflowType(workflow: string): workflow is BlockImageWorkflowType {
  return (BLOCK_IMAGE_WORKFLOW_TYPES as readonly string[]).includes(workflow);
}

/**
 * Resolve which image graph workflow a block body maps to when combined with the
 * checkpoint's ecosystem:
 *   - no source image                          → `txt2img`
 *   - source image + SD-family ecosystem       → `img2img`      (Image Variations)
 *   - source image + edit-capable ecosystem    → `img2img:edit` (OpenAI / Qwen /
 *                                                Flux Kontext / … — EDIT_IMG_IDS)
 *   - source image + neither variant available → BAD_REQUEST
 *
 * Variant selection is DETERMINISTIC via `isWorkflowAvailable` (the same
 * availability check the generation graph uses) — it never leans on
 * `DataGraph.safeParse` auto-correcting a mis-routed ecosystem (the #3127 bug
 * class: safeParse runs `_evaluate` before `_validate`, silently rewriting an
 * unsupported ecosystem to a supported one and returning a mis-routed graph as
 * success). `ecosystemId` is the checkpoint's resolved ecosystem id; when it is
 * omitted (unrecognized base model) a source-image body is rejected fail-closed.
 */
export function resolveBlockImageWorkflowType(
  body: Extract<BlockWorkflowBody, { kind: 'textToImage' }>,
  ecosystemId?: number
): BlockImageWorkflowType {
  if (!body.sourceImage) return 'txt2img';
  if (ecosystemId != null && isWorkflowAvailable('img2img', ecosystemId)) return 'img2img';
  if (ecosystemId != null && isWorkflowAvailable('img2img:edit', ecosystemId)) return 'img2img:edit';
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      'img2img (source image) is not supported for this checkpoint — its ecosystem supports ' +
      'neither img2img (SD-family) nor img2img:edit (edit-capable: OpenAI/Qwen/Flux Kontext/…)',
  });
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
 * WORKFLOW TYPE: with no override, the variant is derived from the body + the
 * checkpoint's ecosystem (`resolveBlockImageWorkflowType`): no source image →
 * txt2img; source image + SD-family → img2img; source image + edit-capable
 * ecosystem (OpenAI/Qwen/Flux Kontext/… — EDIT_IMG_IDS) → img2img:edit; source
 * image + neither variant → BAD_REQUEST. Selection is DETERMINISTIC via
 * `isWorkflowAvailable`, never safeParse auto-correction (#3127). The resolved
 * type is VALIDATED against BLOCK_IMAGE_WORKFLOW_TYPES — a non-image type is
 * rejected fail-closed. The explicit `workflowTypeOverride` parameter is the
 * seam a later phase / an explicit-type body flows through; the router passes
 * nothing and gets the derived type.
 *
 * DIMENSIONS: for txt2img the graph's `aspectRatio` node snaps the block-supplied
 * width/height to the ecosystem's nearest canonical bucket (the block sends
 * arbitrary 64–2048 dims from untrusted iframe UI). For both img2img variants the
 * graph derives output dimensions from the source image (SD) or the ecosystem's
 * aspectRatio default (edit), so aspectRatio is omitted.
 */
export function buildImageWorkflowInput(
  body: Extract<BlockWorkflowBody, { kind: 'textToImage' }>,
  resolved: {
    baseModel: string;
    modelType: string;
    checkpointVersionId: number;
    checkpointBaseModel: string;
  },
  workflowTypeOverride?: string
): Record<string, unknown> {
  // Ecosystem drives the graph's branch + resource enrichment AND the img2img
  // variant selection. Fall back to SDXL (the graph's ultimate fallback) if the
  // checkpoint's baseModel is unrecognized — the resource belt will still gate it.
  const ecoRecord = getEcosystem(resolved.checkpointBaseModel);
  const ecosystem = ecoRecord?.key ?? 'SDXL';

  // Resolve the workflow variant. The router passes no override → derive it from
  // the body + ecosystem (txt2img / img2img / img2img:edit, DETERMINISTICALLY via
  // isWorkflowAvailable — see resolveBlockImageWorkflowType). An explicit override
  // is the seam a later phase / an explicit-type body flows through; it is
  // validated against the image allowlist + the ecosystem-variant guard below.
  const workflowType = workflowTypeOverride ?? resolveBlockImageWorkflowType(body, ecoRecord?.id);

  if (!isBlockImageWorkflowType(workflowType)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `unsupported block workflow type '${workflowType}' — only image workflows (${BLOCK_IMAGE_WORKFLOW_TYPES.join(
        ', '
      )}) are supported`,
    });
  }

  // Deterministic ecosystem/variant guard (covers BOTH the derive- and
  // override-paths). Plain `img2img` ("Image Variations") is SD-family-only and
  // `img2img:edit` is EDIT_IMG_IDS-only (OpenAI/Qwen/Flux Kontext/…) in the
  // generation graph. Reject a variant the checkpoint's ecosystem doesn't support
  // HERE rather than lean on the graph: `DataGraph.safeParse` runs its auto-
  // correct pass (`_evaluate`) BEFORE `_validate`, so an unsupported checkpoint
  // would be silently REWRITTEN to a supported ecosystem (keeping the caller's
  // checkpoint version id) and returned as a SUCCESSFUL but mis-routed graph —
  // the whatIf preflight would price that mis-route too. Deriving support from
  // `isWorkflowAvailable(workflowType, …)` keeps this in lockstep with the graph
  // config (single source of truth) — the #3127 bug class.
  if (
    (workflowType === 'img2img' || workflowType === 'img2img:edit') &&
    (!ecoRecord || !isWorkflowAvailable(workflowType, ecoRecord.id))
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `workflow '${workflowType}' is not supported for base model '${resolved.checkpointBaseModel}'`,
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

  if (workflowType === 'img2img' || workflowType === 'img2img:edit') {
    // Both img2img variants take the bounded source image as the graph's
    // `images` init/reference node — SD-family "Image Variations" (`img2img`)
    // AND edit-capable "img2img:edit" (OpenAI/Qwen/Flux Kontext/…). This mirrors
    // the onsite generator, which feeds the source image into the same `images`
    // node for these ecosystems (see openai-graph / flux-kontext-graph /
    // qwen-graph: `images` node shown `when: !workflow.startsWith('txt')`). The
    // denoise/edit node applies at its default and output dimensions derive from
    // the source (SD) or the ecosystem's aspectRatio default (edit) — so
    // aspectRatio is OMITTED here. `sourceImage` is guaranteed present (the
    // variant only resolves to an img2img* type when the body carries one); the
    // fallback keeps the types honest for an explicit-type caller. The graph's
    // imagesNode reads { url, width, height }; extra fields are stripped by its
    // object parse.
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

// ── customComfy translator + step builder (App Blocks customComfy bridge, v1) ─
// INERT/DARK: neither function is called by the live blocks.router yet. The
// router still handles ONLY `textToImage`; PR6 branches submit/estimate on
// `kind==='customComfy'` and calls these two, wrapped in the post-paid budget
// belt. Added here now so PR6 is a thin wiring change over reviewed building
// blocks.

/**
 * Translate a validated `customComfy` body into the reusable customComfy step
 * INPUT (`{ resources, trace, workflow }`). The wire schema only did the coarse
 * gate (`recipe` ∈ registry, `params` an opaque record); this applies the
 * recipe's OWN `.strict()` param schema (the real prompt/seed/engine/accountType
 * bounds) and then runs the recipe's PURE graph builder.
 *
 * The returned input is intentionally reusable for a future prepaid
 * `$type:'comfy'` registered-definition path — only the step WRAPPER
 * (`createBlockCustomComfyStep`) is customComfy-specific, so the graph
 * construction never has to change if the step type later does.
 */
export function buildCustomComfyWorkflowInput(
  recipe: AnyBlockRecipe,
  rawParams: unknown,
  resolved: ResolvedRecipeResources = {}
): CustomComfyStepInput {
  // `.parse` throws a ZodError on an out-of-bounds param (e.g. prompt > 1500,
  // unknown engine, extra field) — the router (PR6) maps it to a BAD_REQUEST /
  // failed-snapshot, fail-closed. The coarse wire gate never validated these.
  const params = recipe.paramSchema.parse(rawParams);
  return recipe.buildStep(params, resolved);
}

/** The step name every block customComfy step carries (queue provenance). */
export const BLOCK_CUSTOM_COMFY_STEP_NAME = 'block-custom-comfy';

// Format a whole-second timeout as the orchestrator's `HH:MM:SS` step-timeout
// string (WorkflowStep.timeout). 180 → '00:03:00'.
function formatStepTimeout(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Wrap a recipe's customComfy step input into the `$type:'customComfy'` step,
 * STAMPING the recipe's aggressive `stepTimeoutSeconds` as the step `timeout`
 * (formatted `HH:MM:SS`). That timeout is the ONLY deterministic per-job Buzz
 * bound the orchestrator offers: at `job.ExpireAt` the job is canceled and
 * billed for measured runtime, so worst-case Buzz = `ceil(timeout_s × 1)` =
 * `recipe.maxBuzz` (plan §5). This is what makes the post-paid path bounded.
 *
 * Sibling of `createBlockTextToImageStep` (blocks.router.ts) — but a customComfy
 * step is built by DIRECT object construction (the recipe's graph), NOT through
 * the generation-graph pipeline, so it needs none of that helper's
 * `createWorkflowStepsFromGraphInput` machinery.
 */
export function createBlockCustomComfyStep(
  recipe: AnyBlockRecipe,
  input: CustomComfyStepInput
): CustomComfyStepTemplate {
  return {
    $type: 'customComfy',
    name: BLOCK_CUSTOM_COMFY_STEP_NAME,
    timeout: formatStepTimeout(recipe.stepTimeoutSeconds),
    input,
  };
}
