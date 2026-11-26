import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { coveragePair, nextCoverageEnabled } from '~/server/services/generation/coverage-source';
import type {
  CustomComfyStepTemplate,
  Workflow,
  WorkflowStatus,
} from '@civitai/orchestration-client';
import type { AnyBlockRecipe, CustomComfyStepInput, ResolvedRecipeResources } from './recipes';
import {
  getStepByOrchestratorType,
  canonicalTrainingStepType,
  NATIVE_STEP_OUTPUT_KEY,
  NATIVELY_EXTRACTED_STEP_TYPES,
  postureProducesMedia,
  splitPassThroughStep,
  withEveryBlobSurfaceable,
} from './steps';
import { mediaSlotsFromBlobs, slotFromMedia } from './steps';
import type { OrchestratorBlobLike, StepOutputSlot, TrainedEpoch } from './steps';
import { isNeverRatedVideoStep } from '~/shared/orchestrator/workflow-data';
import { maxNsfwLevel } from '~/shared/constants/orchestrator.constants';
import { classifyBlockOutput, isUnrestrictedOutput } from './block-output-restriction';
import type { BlockOutputWorkflowFacts } from './block-output-restriction';
import {
  applyServingOffRules,
  applyServingRules,
  restrictWhileServingUnknown,
  isPrivateGenerationWorkflow,
  mintBlockOutput,
  type BlockOutputView,
} from './block-output-mint';
import { hasRecasedTwin, isRepeatStepType } from './workflow-graph';
import { APP_BLOCK_TAG_PREFIX } from '~/shared/utils/app-block-tags';
import { safeQuoteReason } from './pass-through-quote-failure';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { dbRead } from '~/server/db/client';
import { nsfwLevelFromContentRating } from '~/shared/constants/browsingLevel.constants';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';
import { getEcosystem } from '~/shared/constants/basemodel.constants';
import { isWorkflowAvailable } from '~/shared/generation/config/workflows';
import { resolveVersionWorkflowScope } from '~/shared/generation/workflow-capability';
import {
  readModelSubstitutionsFromMetadata,
  WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY,
} from '~/shared/generation/model-substitution';
import { getImagesLimit } from '~/shared/generation/images-limit';
import { resolveDefaultSampler } from '~/shared/generation/sampler-options';
import { ModelType } from '~/shared/utils/prisma/enums';
import { isSingletonSlotResource } from '~/shared/utils/resource.utils';
import {
  recordOutputTruncated,
  type AppBlockSucceededWithoutMediaReason,
} from '~/server/metrics/app-block-runtime.metrics';
import type {
  BlockModel3dOutput,
  BlockPublishedModel,
  BlockSourceImage,
  BlockWorkflowBody,
  BlockWorkflowEta,
  BlockWorkflowOutput,
  BlockWorkflowSnapshot,
  BlockWorkflowStepSnapshot,
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
 * 🔴 The key + reader for silent checkpoint substitutions persisted on the
 * ORCHESTRATOR WORKFLOW's `metadata` (issue #3520) now live in
 * `~/shared/generation/model-substitution` — the tRPC generation path
 * needs the identical parse (#3665), and a second copy of a validating predicate
 * is how the same bug gets fixed at one site and not the other. Re-exported here
 * because this module is where the block path's callers already look for it.
 *
 * WHY THE ORCHESTRATOR AND NOT A COLUMN. The record is produced during graph
 * validation, which happens once, at submit. But blocks render from the
 * TERMINAL POLL — that is the only snapshot that carries `imageUrls` — and
 * `pollWorkflow` / `cancelWorkflow` build their snapshot from a freshly fetched
 * `Workflow` with no access to that long-gone request context. A submit-reply-
 * only field is therefore gone by the time there is anything to display beside
 * it, and `block_workflows` does not retain the submitted body, so it is not
 * recoverable afterwards either.
 *
 * `WorkflowTemplate.metadata` is a free-form `{ [key: string]: unknown }` bag
 * that the orchestrator persists and echoes back on every read, which makes it
 * the natural carrier: written once at submit, readable on every subsequent
 * poll, and NO database change.
 *
 * 🔴 The old note here said the generation formatter "builds its normalized
 * metadata from a fixed key list, so an extra key is inert there". That was
 * true, and it was the defect #3665 had to fix: the key round-tripped fine but
 * `formatGenerationResponse2` dropped it on read-back, so the generation path
 * could persist the record and still never surface it. The formatter now passes
 * it through explicitly.
 */
export { WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY, readModelSubstitutionsFromMetadata };

/**
 * Flatten an orchestrator Workflow into the wire-stable shape the iframe
 * receives. Only image URLs that are `available` and have a non-null url are
 * surfaced — pending/blocked blobs are dropped rather than sending dead links
 * the block would render as broken images.
 *
 * 🔴 `view` IS REQUIRED, and that is the guard: its ceiling is the calling token's
 * maturity ceiling, and every available output is passed through `classifyBlockOutput`
 * with it. A RESTRICTED output is reported on
 * `outputs` (and `steps[].outputs`) in position, with no url, and is left out of
 * `imageUrls`, `steps[].imageUrls` and `model3dOutputs`. See `outputs` in
 * `schema/blocks/workflow.schema`. Its `mint` (`resolveBlockOutputView`) turns every
 * url the app is given into a host media ticket while serving is on for the viewer.
 */
export function snapshotFromWorkflow(
  workflow: Workflow,
  view: BlockOutputView,
  /**
   * Facts known to the SUBMITTING request that the orchestrator Workflow object
   * does not itself model — currently only the silent checkpoint substitutions
   * recorded on the request's `GenerationCtx` (issue #3520).
   *
   * Optional, and only an OVERRIDE: when omitted, the same information is
   * recovered from the workflow's persisted metadata (see
   * {@link WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY}), which is what lets a
   * poll — the snapshot a block actually renders from — still report it. Passing
   * it explicitly is preferred on the submit and estimate replies, where the
   * request's own collector is in scope and is authoritative for that exact
   * validation (and where, on the estimate path, nothing was persisted at all).
   */
  extra?: {
    modelSubstitutions?: BlockWorkflowSnapshot['modelSubstitutions'];
    /**
     * Whole Buzz to ADD to the reported `cost.total`, for a charge the viewer
     * will incur that the orchestrator's own cost does not include — today only
     * the App Blocks per-generation AUTHOR FEE, on the two ESTIMATE arms.
     *
     * `cost.total` includes it, and the same amount is reported beside it as
     * `cost.authorFee`. Passing this argument at all — `0` included — is what
     * makes `authorFee` appear: `0` tells the block "no fee on this request",
     * while omitting the argument leaves the total un-itemised.
     *
     * 🔴 AND IT IS AN ESTIMATE-ONLY ARGUMENT. A SUBMIT must not pass it: there
     * the orchestrator's realized `cost.total` is the generation's own price and
     * the settle/refund arithmetic downstream (`snapshot.cost?.total ?? ceiling`)
     * is taken against it, so inflating it there would refund the fee back into
     * every cap while the fee stands. Pinned by
     * `no-divergent-author-fee-base.test.ts`.
     *
     * Ignored when the workflow reports no cost at all — there is no total to
     * correct, and inventing one would report a fee as if it were the price.
     */
    additionalCostBuzz?: number;
    /** The clock for the rating hold's deadline ({@link isRatingHoldExpired}); tests only. */
    now?: number;
  }
): BlockWorkflowSnapshot {
  // The orchestrator's status. The app is told `appWorkflowStatus(...)` of it instead.
  const status = orchestratorBlockStatus(workflow);
  const now = extra?.now ?? Date.now();
  const imageUrls: string[] = [];
  const outputs: BlockWorkflowOutput[] = [];
  const stepOutputs: NonNullable<BlockWorkflowSnapshot['stepOutputs']> = [];
  const trainedEpochs: TrainedEpoch[] = [];
  const model3dOutputs: BlockModel3dOutput[] = [];
  // `kind:'workflow'` only: which steps that submit named, read back from the
  // workflow's own metadata. `null` for every other kind.
  const submittedSteps = readBlockWorkflowSteps(workflow.metadata);
  const steps: BlockWorkflowStepSnapshot[] = [];
  const workflowTerminal = TERMINAL_SNAPSHOT_STATUSES.has(status);
  for (const step of workflow.steps ?? []) {
    const member = submittedSteps ? resolveBlockWorkflowStep(submittedSteps, step.name) : null;
    if (member) {
      // A `repeat` step's own output is a copy of the child steps it generated,
      // and those are steps of this workflow in their own right — each handled
      // below as a member. Extracting the copy too would publish every child
      // image twice.
      const extracted = isRepeatStepType(step.$type)
        ? EMPTY_STEP_EXTRACT
        : extractSnapshotStep(step, true);
      const stepOutputList = classifyOutputs(extracted.media, step, workflow, view);
      const stepUrls = unrestrictedUrls(stepOutputList);
      if (!member.suppressOutput) {
        imageUrls.push(...stepUrls);
        outputs.push(...stepOutputList);
        // Labels only for urls that are in `imageUrls` — see the field's own doc.
        model3dOutputs.push(...labelsFor(extracted.model3d, extracted.media, stepOutputList));
      }
      trainedEpochs.push(...extracted.trainedEpochs);
      const error = stepFailureReason(step);
      const live = stepLiveState(step, workflowTerminal);
      steps.push({
        name: step.name,
        $type: step.$type,
        status: ORCH_STATUS_MAP[step.status] ?? 'pending',
        ...(!member.suppressOutput && stepUrls.length > 0 ? { imageUrls: stepUrls } : {}),
        ...(!member.suppressOutput && stepOutputList.length > 0 ? { outputs: stepOutputList } : {}),
        ...(!member.suppressOutput && anyPending(stepOutputList)
          ? { ratingPending: true as const }
          : {}),
        ...(extracted.rest !== undefined ? { output: extracted.rest } : {}),
        ...(error ? { error } : {}),
        // Each omitted when there is nothing to report — see the fields' docs.
        ...(live.queue ? { queue: live.queue } : {}),
        ...(live.progress !== null ? { progress: live.progress } : {}),
        ...(live.startedAt !== null ? { startedAt: live.startedAt } : {}),
        ...(live.completedAt !== null ? { completedAt: live.completedAt } : {}),
      });
      continue;
    }
    const extracted = extractSnapshotStep(step, step.name === BLOCK_STEP_NAME);
    const stepOutputList = classifyOutputs(extracted.media, step, workflow, view);
    const stepUrls = unrestrictedUrls(stepOutputList);
    imageUrls.push(...stepUrls);
    outputs.push(...stepOutputList);
    trainedEpochs.push(...extracted.trainedEpochs);
    // ADDITIVE: the 3D models among those urls, labelled — `imageUrls` is unchanged.
    model3dOutputs.push(...labelsFor(extracted.model3d, extracted.media, stepOutputList));
    // A step with no output yet — the submit reply — would otherwise get an
    // entry saying nothing.
    if (extracted.rest !== undefined) {
      stepOutputs.push({ $type: step.$type, output: extracted.rest });
    }
  }
  const orchestratorTotal = workflow.cost?.total;
  // Only a WHOLE, POSITIVE addition moves the number. A NaN/Infinity would
  // propagate into the reported price silently, and a negative one would make
  // the block show LESS than it will be charged — the one direction this whole
  // change exists to remove.
  //
  // 🔴 `isInteger`, NOT JUST `isFinite` — BUZZ IS WHOLE AND THE TYPE DOES NOT SAY
  // SO. `additionalCostBuzz: number` accepts a fraction, and today's only caller
  // passes `computation.feeBuzz`, an integer by construction — so the constraint
  // is true by accident of the caller, which is exactly the kind of guarantee
  // that stops being true when a second caller appears. Checked here rather than
  // documented, because the wrong outcome is a fractional Buzz price on the wire
  // with nothing objecting. (`isInteger` implies `isFinite`, which is why that
  // leg is gone rather than kept alongside.)
  const additional = extra?.additionalCostBuzz;
  // What actually goes into the total: 0 for an addend the guard above rejects.
  const addedAuthorFee =
    additional === undefined
      ? undefined
      : typeof additional === 'number' && Number.isInteger(additional) && additional > 0
      ? additional
      : 0;
  const total =
    typeof orchestratorTotal === 'number' && addedAuthorFee !== undefined
      ? orchestratorTotal + addedAuthorFee
      : orchestratorTotal;
  const spentAccountType = primaryDebitedAccountType(workflow.transactions);
  // #3520 — prefer the CALLER-SUPPLIED record (the submit/estimate reply, where
  // the request's own collector is still in scope and is authoritative for this
  // exact validation) and otherwise recover it from the workflow's persisted
  // metadata, which is what makes the field survive to the terminal poll.
  const modelSubstitutions = extra?.modelSubstitutions?.length
    ? extra.modelSubstitutions
    : readModelSubstitutionsFromMetadata(workflow.metadata);
  const publishedModel = readBlockPublishedModel(workflow);
  const eta = selectWorkflowEta(workflow.steps ?? [], workflowTerminal);
  return {
    // The orchestrator stamps a server-minted id on EVERY workflow it returns,
    // whatIf included (`WorkflowGrain.TryInitializeAsync` sets `Id` from the
    // grain key before the estimate-only early return), so `workflow.id` is not
    // observed absent on any path today and this fallback is currently
    // unreachable. It is kept as a defensive floor because the orchestrator's
    // OpenAPI declares `id` optional-and-nullable with
    // `DefaultIgnoreCondition=WhenWritingNull`, so a future regression would
    // silently OMIT the field rather than error. The floor must be non-empty:
    // the block SDK's inbound validator (isValidWorkflowSnapshot) DROPS any
    // snapshot whose workflowId is an empty string, so an `''` here would
    // silently strand the ESTIMATE_RESULT reply until the 120s transport
    // timeout (the block then falls back to a "≤ budget" cost). The block
    // treats estimate results as a cost quote only and never polls on this id
    // (the request is correlated by requestId, not workflowId).
    workflowId: workflow.id ?? 'whatif',
    status: appWorkflowStatus(workflow, status, outputs, now),
    ...(typeof total === 'number'
      ? { cost: { total, ...(addedAuthorFee !== undefined ? { authorFee: addedAuthorFee } : {}) } }
      : {}),
    ...(imageUrls.length > 0 ? { imageUrls } : {}),
    // See the field's own doc in `schema/blocks/workflow.schema`. Omitted when empty.
    ...(outputs.length > 0 ? { outputs } : {}),
    // See the field's own doc in `schema/blocks/workflow.schema`. Omitted when false.
    ...(anyPending(outputs) ? { ratingPending: true as const } : {}),
    // See the field's own doc in `schema/blocks/workflow.schema`.
    ...(stepOutputs.length > 0 ? { stepOutputs } : {}),
    // Surface the realized spent account (money page blocks). Additive +
    // optional — omitted when there's no debit to report so every existing
    // snapshot stays byte-identical to before.
    ...(spentAccountType ? { spentAccountType } : {}),
    // Omitted entirely when nothing was substituted — the common case — so a
    // normal snapshot is unchanged on the wire.
    ...(modelSubstitutions?.length ? { modelSubstitutions } : {}),
    ...(trainedEpochs.length > 0 ? { trainedEpochs } : {}),
    ...(publishedModel ? { publishedModel } : {}),
    // See the field's own doc in `schema/blocks/workflow.schema`. Omitted when none.
    ...(model3dOutputs.length > 0 ? { model3dOutputs } : {}),
    // See the field's own doc in `schema/blocks/workflow.schema`.
    ...(steps.length > 0 ? { steps } : {}),
    // See the field's own doc in `schema/blocks/workflow.schema`. Omitted when null.
    ...(eta ? { eta } : {}),
  };
}

/**
 * Each output position of ONE step, through the restriction rule, in order — the one
 * classification both producers run, so the snapshot and the listing cannot disagree.
 * A 3D mesh first takes its rating from the step's thumbnail and the workflow's
 * `model3DPreview` renders ({@link propagateMeshRating}).
 */
function classifyOutputs(
  slots: readonly StepOutputSlot[],
  step: { $type: string; status?: string; output?: unknown; metadata?: unknown; input?: unknown },
  workflow: Workflow,
  view: BlockOutputView
): BlockWorkflowOutput[] {
  const neverRatedVideo = isBlockNeverRatedVideoStep(step, workflow);
  const mintStep = view.mint
    ? {
        workflowId: workflow.id ?? '',
        privateGen: isPrivateGenerationWorkflow(workflow, step),
        neverRatedVideoStep: neverRatedVideo,
      }
    : null;
  return propagateMeshRating(slots, step, workflow).map((m) => {
    const output = classifyBlockOutput(m, workflow as BlockOutputWorkflowFacts, view, {
      neverRated: m.neverRated === true,
      // 🔴 MIRRORS THE SITE (`workflow-data.ts`, `NEVER_RATED_VIDEO_ECOSYSTEMS`): the
      // provider moderates a never-rated engine's own output, so an UNRATED video from
      // one is delivered — neither held nor locked — whatever the ceiling. A rating
      // that does arrive still meets every ceiling check.
      unratedDelivered: neverRatedVideo && m.type === 'video',
    });
    if (view.servingUnknown) return restrictWhileServingUnknown(output);
    if (view.mint && mintStep) {
      return mintBlockOutput(output, m, mintStep, { ...view, mint: view.mint });
    }
    return view.serving
      ? applyServingRules(output, m, { neverRatedVideoStep: neverRatedVideo })
      : applyServingOffRules(
          output,
          m,
          { neverRatedVideoStep: neverRatedVideo },
          { neverRated: m.neverRated === true }
        );
  });
}

/**
 * The orchestrator `videoGen` engines whose output is never rated, as App Blocks submits
 * them: `input.engine` is the value the block sent, echoed back unchanged. The SAME set
 * as the site's `NEVER_RATED_VIDEO_ECOSYSTEMS` (`GeminiOmni`, `Grok`, `Kling`, `Veo3`,
 * `Vidu`), spelled as engines — the site reads the ECOSYSTEM from
 * `workflow.metadata.params`, which the App Blocks submit never writes. A versioned
 * engine (`kling-v3`, `vidu-q4`) matches by its family prefix.
 */
const NEVER_RATED_VIDEO_ENGINES = ['gemini-omni', 'grok', 'kling', 'veo3', 'vidu'] as const;

/** Whether a step's videos will never be rated: the site's rule, or the engine the block sent. */
export function isBlockNeverRatedVideoStep(
  step: { $type: string; metadata?: unknown; input?: unknown },
  workflow: Pick<Workflow, 'metadata'>
): boolean {
  if (step.$type !== 'videoGen') return false;
  if (
    isNeverRatedVideoStep(
      step as Parameters<typeof isNeverRatedVideoStep>[0],
      (workflow.metadata as { params?: Parameters<typeof isNeverRatedVideoStep>[1] } | undefined)
        ?.params
    )
  ) {
    // The ecosystem is read from `metadata.params`. A recipe submit builds those params
    // from the APP's own params through the generation graph, and the step's engine is
    // derived from that same ecosystem. So it is app-chosen, not server-chosen: what it
    // selects is an engine the provider moderates, the same set the engine check below
    // delivers.
    return true;
  }
  const input = step.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  // 🔴 `input` IS THE APP'S OWN OBJECT. A re-cased twin (`Engine`) may be the key the
  // orchestrator binds, so with one present the engine is unknown: not never-rated,
  // and its outputs go through the normal hold.
  if (hasRecasedTwin(input as Record<string, unknown>, 'engine')) return false;
  const engine = (input as { engine?: unknown }).engine;
  if (typeof engine !== 'string') return false;
  const e = engine.trim().toLowerCase();
  return NEVER_RATED_VIDEO_ENGINES.some((n) => e === n || e.startsWith(`${n}-`));
}

type MeshRating =
  /** Every source has rated: the most severe of them. */
  | { kind: 'rated'; rating: NonNullable<Parameters<typeof maxNsfwLevel>[0][number]> }
  /** A source exists that has not rated yet: hold. */
  | { kind: 'pending' }
  /** No source exists and none can come (the step is finished): no rating will arrive. */
  | { kind: 'never' };

const FINISHED_STEP_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'expired',
  'canceled',
]);

/**
 * What a 3D mesh in this step is rated, from its RATING SOURCES — the step's
 * auto-`thumbnail` and every `model3DPreview` render in the workflow.
 *
 * 🔴 PARTIAL IS NOT RATED. `maxNsfwLevel` skips an unrated value, so taking the max over
 * whatever has rated so far would hand a mesh `pg` from a `pg` thumbnail while a preview
 * render that will come back `x` is still running. So: a declared thumbnail without a
 * rating, a preview step that has not finished, or a finished preview with any unrated
 * image makes the mesh PENDING. Only when every source has rated is the max taken. A
 * preview step that finished with no image contributes nothing.
 */
function meshRatingOf(
  step: { status?: string; output?: unknown },
  workflow: Pick<Workflow, 'steps'>
): MeshRating {
  const ratings: Array<Parameters<typeof maxNsfwLevel>[0][number]> = [];
  let sources = 0;
  const thumbnail = (step.output as { thumbnail?: unknown } | undefined)?.thumbnail;
  if (thumbnail && typeof thumbnail === 'object') {
    sources += 1;
    const level = (thumbnail as { nsfwLevel?: unknown }).nsfwLevel;
    if (typeof level !== 'string' || level === '') return { kind: 'pending' };
    ratings.push(level as Parameters<typeof maxNsfwLevel>[0][number]);
  }
  for (const preview of workflow.steps ?? []) {
    if (preview?.$type !== 'model3DPreview') continue;
    if (!FINISHED_STEP_STATUSES.has(preview.status)) return { kind: 'pending' };
    const images =
      (preview as { output?: { images?: Array<{ nsfwLevel?: unknown } | null> } }).output?.images ??
      [];
    for (const image of images) {
      sources += 1;
      const level = image?.nsfwLevel;
      if (typeof level !== 'string' || level === '') return { kind: 'pending' };
      ratings.push(level as Parameters<typeof maxNsfwLevel>[0][number]);
    }
  }
  const rating = maxNsfwLevel(ratings);
  if (rating) return { kind: 'rated', rating };
  // Every source rated (any unrated one returned above) but none to a level: all
  // `'na'` — the verdict with no level — or a value `maxNsfwLevel` does not know, which
  // is passed on so the classifier fails closed on it.
  if (sources > 0) {
    const odd = ratings.find((r) => !isNaVerdict(r));
    return {
      kind: 'rated',
      rating: (odd ?? 'na') as NonNullable<Parameters<typeof maxNsfwLevel>[0][number]>,
    };
  }
  return FINISHED_STEP_STATUSES.has(step.status ?? '') ? { kind: 'never' } : { kind: 'pending' };
}

/**
 * The `'na'` verdict, in ANY case or padding, as the classifier reads it
 * (`classifyBlockOutput` trims and lower-cases). Compared exactly, an `'NA'` on the mesh
 * would read as a real value here, mask an unknown source value, and then be delivered
 * by the classifier as `'na'`.
 */
function isNaVerdict(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'na';
}

/**
 * 🔴 THE ORCHESTRATOR NEVER RATES A 3D MESH (`nsfwLevel: null` on every `model3d` blob —
 * `model`, `fbxModel`, rigged and animated variants alike). The on-site formatter
 * (`formatStepOutputs`) copies the most severe of the step's auto-`thumbnail` rating and
 * the workflow's `model3DPreview` render rating onto it; this is that rule for App
 * Blocks, made strict ({@link meshRatingOf}): every source must have rated, else the mesh
 * stays unrated and is held; with no source at all on a finished step it is marked
 * `neverRated`. Non-mesh slots are untouched.
 */
export function propagateMeshRating(
  slots: readonly StepOutputSlot[],
  step: { status?: string; output?: unknown },
  workflow: Pick<Workflow, 'steps'>
): StepOutputSlot[] {
  if (!slots.some((s) => s.type === 'model3d')) return [...slots];
  const mesh = meshRatingOf(step, workflow);
  return slots.map((s) => {
    if (s.type !== 'model3d') return s;
    if (mesh.kind === 'rated') {
      // The most severe real rating wins; with none (all `'na'`), the verdict carries.
      return {
        ...s,
        nsfwLevel:
          maxNsfwLevel([s.nsfwLevel as Parameters<typeof maxNsfwLevel>[0][number], mesh.rating]) ??
          // A source value `maxNsfwLevel` does not know beats a mesh's own `'na'`, so
          // it reaches the classifier and fails closed there.
          (s.nsfwLevel && !isNaVerdict(s.nsfwLevel) ? s.nsfwLevel : mesh.rating),
      };
    }
    // A source that has not rated yet: hold the mesh, whatever it carries itself.
    if (mesh.kind === 'pending') return { ...s, nsfwLevel: null };
    // No source at all: a rating on the mesh itself is all there is; without one, none
    // will ever come.
    return s.nsfwLevel ? s : { ...s, nsfwLevel: null, neverRated: true as const };
  });
}

/**
 * 🔴 HOW LONG A FINISHED WORKFLOW MAY STILL BE REPORTED `processing` WHILE AN OUTPUT
 * WAITS FOR ITS RATING, measured from the workflow's completion
 * ({@link ratingHoldAnchorMs}). After it the workflow's real terminal status is
 * reported again, the output still `{ pending: true }` with `ratingPending` (exactly
 * what #8994 sends), so no app polls forever. The output is NOT turned into a
 * restricted `'unrated'` entry: that reason means "no rating will ever come" and is
 * terminal in the wire contract, and the unlock dialog answers it as such.
 *
 * 5 minutes: well past the blob scan latency tail
 * (`orchestration_blob_scan_latency_seconds`), and under `@civitai/blocks-react` `watch`'s
 * default 10 minute timeout, which counts from the watch's start, not from completion.
 */
export const RATING_HOLD_MAX_MS = 5 * 60_000;

/**
 * When the workflow finished, in epoch ms: its `completedAt`, else its latest step
 * `completedAt`, else its `createdAt` — so a workflow missing every completion stamp is
 * still bounded. `null` only when none of them parses.
 */
function ratingHoldAnchorMs(workflow: Workflow): number | null {
  const candidates: Array<string | null | undefined> = [workflow.completedAt];
  if (!workflow.completedAt) {
    for (const step of workflow.steps ?? []) {
      candidates.push((step as { completedAt?: string | null }).completedAt);
    }
  }
  let anchor: number | null = null;
  for (const c of candidates) {
    const t = typeof c === 'string' ? Date.parse(c) : NaN;
    if (Number.isFinite(t) && (anchor === null || t > anchor)) anchor = t;
  }
  if (anchor !== null) return anchor;
  const created = Date.parse(workflow.createdAt);
  return Number.isFinite(created) ? created : null;
}

/**
 * Whether the rating hold has run out for this workflow: it is terminal and finished at
 * least {@link RATING_HOLD_MAX_MS} before `now`. A record with no parseable timestamp
 * at all (`createdAt` is required on every orchestrator workflow, so only a malformed
 * one) is never run out: its output stays held, which never hands out a url.
 */
export function isRatingHoldExpired(workflow: Workflow, now: number): boolean {
  if (!TERMINAL_SNAPSHOT_STATUSES.has(orchestratorBlockStatus(workflow))) return false;
  const anchor = ratingHoldAnchorMs(workflow);
  return anchor !== null && now - anchor >= RATING_HOLD_MAX_MS;
}

/**
 * The workflow's REAL block-contract status, before {@link appWorkflowStatus}. For the
 * host's own bookkeeping (the read model, settle, the post terminality gate), which must
 * not wait on a rating the way an app is told to.
 */
export function orchestratorBlockStatus(
  workflow: Pick<Workflow, 'status'>
): BlockWorkflowSnapshot['status'] {
  return ORCH_STATUS_MAP[workflow.status] ?? 'pending';
}

/**
 * 🔴 THE STATUS AN APP IS TOLD, for every snapshot and listing producer — the one place
 * this rule lives. A `succeeded` workflow with an output still held for its rating
 * (`{ pending: true }`) is reported `processing`.
 *
 * WHY. Apps built on `@civitai/app-sdk` before `ratingPending` existed stop polling at
 * the first `succeeded` and keep whatever `imageUrls` it carried, so an output held for
 * its rating was lost for good although the viewer paid for it. Every app already keeps
 * polling on `processing`. The hold is bounded: after {@link RATING_HOLD_MAX_MS} the
 * real status returns with the output still pending. `failed` / `expired` / `canceled`
 * are passed through: no app keeps outputs on them as a success, and the cancel and
 * refund paths key on them.
 *
 * ⚠️ Applies to every app, new SDKs included: the host cannot tell which apps need it,
 * and an app that polls by hand and stops at `succeeded` loses the image whatever its
 * SDK version. Cost: a `watch` caller can hit its own timeout on this `processing`
 * snapshot.
 */
export function appWorkflowStatus(
  workflow: Workflow,
  status: BlockWorkflowSnapshot['status'],
  outputs: readonly BlockWorkflowOutput[],
  now: number
): BlockWorkflowSnapshot['status'] {
  if (status !== 'succeeded' || !anyPending(outputs)) return status;
  return isRatingHoldExpired(workflow, now) ? status : 'processing';
}

/** True when any entry is held for its rating — what sets `ratingPending`. */
function anyPending(outputs: readonly BlockWorkflowOutput[]): boolean {
  return outputs.some((o) => 'pending' in o && o.pending === true);
}

/** The urls of the unrestricted entries, in order — what `imageUrls` carries. */
function unrestrictedUrls(outputs: readonly BlockWorkflowOutput[]): string[] {
  const urls: string[] = [];
  for (const o of outputs) if (isUnrestrictedOutput(o)) urls.push(o.url);
  return urls;
}

/**
 * 3D labels only for urls the app is given (a restricted model's url is withheld), each
 * carrying the url the app was given for that position.
 */
function labelsFor(
  labels: readonly BlockModel3dOutput[],
  slots: readonly StepOutputSlot[],
  outputs: readonly BlockWorkflowOutput[]
): BlockModel3dOutput[] {
  if (labels.length === 0) return [];
  const given = new Map<string, string>();
  slots.forEach((slot, i) => {
    const output = outputs[i];
    if (output && isUnrestrictedOutput(output)) given.set(slot.url, output.url);
  });
  return labels.flatMap((l) => {
    const url = given.get(l.url);
    return url === undefined ? [] : [url === l.url ? l : { ...l, url }];
  });
}

const TERMINAL_SNAPSHOT_STATUSES: ReadonlySet<BlockWorkflowSnapshot['status']> = new Set<
  BlockWorkflowSnapshot['status']
>(['succeeded', 'failed', 'expired', 'canceled']);

/**
 * The step `$type`s whose orchestrator `estimatedProgressRate` is a fraction of the
 * WHOLE step, so it can be shown as "x% done" as it stands. An ALLOWLIST: every
 * other type — including one added to the orchestrator after this list — reports
 * no progress, because the failure it prevents is a bar that fills and restarts.
 *
 *   - `textToImage` — image generation (the original step type).
 *   - `imageGen`    — image generation (the engine-routed successor).
 *   - `videoGen`    — video generation.
 *
 * Deliberately left out, from the orchestrator's step `$type` union:
 *   - `training`, `imageResourceTraining` — the rate is PER EPOCH (0→1 inside each
 *     epoch; see `overallProgressPct` in the training studio, which has to fold it
 *     into a completed-epoch count to make it whole-run).
 *   - `comfy`, `customComfy` — a graph of many nodes; nothing here shows what the
 *     rate covers, so it is not claimed.
 *   - everything else (upscalers, scans, captioning, chat, audio, …) — not
 *     generation, and not checked.
 * Adding a type is a claim about what its rate means; check it against a real run.
 */
export const WHOLE_STEP_PROGRESS_STEP_TYPES: ReadonlySet<string> = new Set([
  'textToImage',
  'imageGen',
  'videoGen',
]);

type WorkflowStepLike = NonNullable<Workflow['steps']>[number];

type StepLiveState = {
  queue: NonNullable<BlockWorkflowStepSnapshot['queue']> | null;
  progress: number | null;
  startedAt: string | null;
  completedAt: string | null;
};

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * A step's queue position, progress and timestamps, read defensively: the orchestrator
 * declares these optional, an older one omits them, and anything of the wrong type is
 * reported as null rather than passed to a block.
 */
function stepLiveState(step: WorkflowStepLike, workflowTerminal: boolean): StepLiveState {
  const raw = step as {
    queuePosition?: unknown;
    estimatedProgressRate?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
  };
  // A finished step, or any step of a finished workflow, is not waiting and not running,
  // whatever stale estimate it still carries.
  const settled = workflowTerminal || TERMINAL_SNAPSHOT_STATUSES.has(ORCH_STATUS_MAP[step.status]);

  let queue: StepLiveState['queue'] = null;
  const qp = raw.queuePosition;
  if (!settled && typeof qp === 'object' && qp !== null) {
    const { support, precedingJobs, estimatedStartAt, estimatedCompleteAt } = qp as Record<
      string,
      unknown
    >;
    if (typeof support === 'string') {
      queue = {
        precedingJobs:
          typeof precedingJobs === 'number' && Number.isInteger(precedingJobs) && precedingJobs >= 0
            ? precedingJobs
            : null,
        estimatedStartAt: stringOrNull(estimatedStartAt),
        estimatedCompleteAt: stringOrNull(estimatedCompleteAt),
        support,
      };
    }
  }

  const rate = raw.estimatedProgressRate;
  const progress =
    !settled &&
    WHOLE_STEP_PROGRESS_STEP_TYPES.has(step.$type) &&
    typeof rate === 'number' &&
    Number.isFinite(rate)
      ? Math.min(1, Math.max(0, rate))
      : null;

  return {
    queue,
    progress,
    startedAt: stringOrNull(raw.startedAt),
    completedAt: stringOrNull(raw.completedAt),
  };
}

/**
 * The snapshot's `eta`: the first step (orchestrator order) with a queue, else the first
 * `processing` step, else none — and none at all once the workflow is terminal. The
 * queued-first order is the generator queue's own (`QueueItem`): a step waiting for a
 * worker is what the viewer is waiting on.
 *
 * Read off EVERY orchestrator step, not off the `steps[]` members: those exist only for
 * `kind:'workflow'`, and the single-step kinds are most of what blocks submit.
 */
function selectWorkflowEta(
  workflowSteps: ReadonlyArray<WorkflowStepLike>,
  workflowTerminal: boolean
): BlockWorkflowEta | null {
  if (workflowTerminal) return null;
  const states = workflowSteps.map((step) => ({ step, live: stepLiveState(step, false) }));
  const chosen =
    states.find(({ live }) => live.queue !== null) ??
    states.find(({ step }) => ORCH_STATUS_MAP[step.status] === 'processing');
  if (!chosen) return null;
  const { step, live } = chosen;
  return {
    stepName: step.name,
    queuedAhead: live.queue?.precedingJobs ?? null,
    startsAt: live.queue?.estimatedStartAt ?? null,
    completesAt: live.queue?.estimatedCompleteAt ?? null,
    progress: live.progress,
    support: live.queue?.support ?? null,
  };
}

/**
 * Where a `kind:'workflow'` submit records the steps it named, on the
 * orchestrator workflow's own `metadata` (the same carrier
 * `WORKFLOW_METADATA_MODEL_SUBSTITUTIONS_KEY` uses, for the same reason: a poll
 * rebuilds the snapshot from a freshly fetched workflow and has no request
 * context). The single-step arms answer "did this bridge submit this step" with
 * one constant step name; N app-named steps cannot, so the list is recorded here.
 *
 * A block cannot write it: workflow metadata is set with the viewer's own
 * orchestrator token, which a block never holds.
 */
export const WORKFLOW_METADATA_BLOCK_STEPS_KEY = 'blockWorkflowSteps';

/** One recorded step. `suppressOutput` is stored only when it is set. */
export type BlockWorkflowStepRecord = { name: string; suppressOutput?: true };

/** The value a `kind:'workflow'` submit writes under the key above. */
export function buildBlockWorkflowStepsMetadata(
  steps: ReadonlyArray<{ name: string; suppressOutput: boolean }>
): BlockWorkflowStepRecord[] {
  return steps.map((step) => ({
    name: step.name,
    ...(step.suppressOutput ? { suppressOutput: true as const } : {}),
  }));
}

/**
 * The recorded steps keyed by name, or `null` when the workflow carries no
 * well-formed record — which is every workflow another kind submitted.
 */
function readBlockWorkflowSteps(
  metadata: unknown
): Map<string, { suppressOutput: boolean }> | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const raw = (metadata as Record<string, unknown>)[WORKFLOW_METADATA_BLOCK_STEPS_KEY];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps = new Map<string, { suppressOutput: boolean }>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { name, suppressOutput } = entry as { name?: unknown; suppressOutput?: unknown };
    if (typeof name !== 'string' || name.length === 0) return null;
    steps.set(name, { suppressOutput: suppressOutput === true });
  }
  return steps;
}

/**
 * The recorded step an orchestrator step belongs to: itself, or — for a child a
 * `repeat` step generated, which the orchestrator names `<repeat name>.<n>` — its
 * recorded ancestor. `null` for a step this bridge did not submit.
 *
 * A recorded name can never contain a `.` (`resolveBlockWorkflowGraph` refuses
 * one), so a child name cannot collide with a recorded one.
 */
function resolveBlockWorkflowStep(
  submitted: Map<string, { suppressOutput: boolean }>,
  stepName: unknown
): { suppressOutput: boolean } | null {
  if (typeof stepName !== 'string') return null;
  const own = submitted.get(stepName);
  if (own) return own;
  const child = /^([^.]+)((?:\.\d+)+)$/.exec(stepName);
  return child ? submitted.get(child[1]) ?? null : null;
}

/** Orchestrator step statuses for which a failure reason is worth reporting. */
const UNSUCCESSFUL_STEP_STATUSES: ReadonlySet<string> = new Set(['failed', 'expired', 'canceled']);

/**
 * The orchestrator's reason for a step that did not succeed — the first of its
 * jobs to give one — and only when it is plain prose (`safeQuoteReason`).
 */
function stepFailureReason(step: NonNullable<Workflow['steps']>[number]): string | undefined {
  if (!UNSUCCESSFUL_STEP_STATUSES.has(step.status)) return undefined;
  // The SDK stopped declaring `jobs` on a step at 0.2.0-beta.125; the response may still carry them.
  const jobs = (step as { jobs?: Array<{ reason?: unknown }> | null }).jobs;
  for (const job of jobs ?? []) {
    const reason = job.reason;
    if (typeof reason !== 'string' || reason.length === 0) continue;
    return safeQuoteReason(reason, '');
  }
  return undefined;
}

type SnapshotStepExtract = {
  /** Output positions (surfaceable and blocked), in the order the step produced them. */
  media: StepOutputSlot[];
  /** A pass-through step's non-blob output; `undefined` for every other step. */
  rest?: unknown;
  trainedEpochs: TrainedEpoch[];
  /** A pass-through step's 3D models, labelled; every url is also in `media`. */
  model3d: BlockModel3dOutput[];
};

const EMPTY_STEP_EXTRACT: SnapshotStepExtract = { media: [], trainedEpochs: [], model3d: [] };

/**
 * What ONE orchestrator step contributes to a snapshot. `bridgeSubmitted` says
 * whether this bridge submitted the step; it only matters for a `$type` nobody
 * extracts (see the note at that branch).
 */
function extractSnapshotStep(
  step: NonNullable<Workflow['steps']>[number],
  bridgeSubmitted: boolean
): SnapshotStepExtract {
  const media: StepOutputSlot[] = [];
  const trainedEpochs: TrainedEpoch[] = [];
  // A REGISTERED step type (`kind: 'step'`) declares its OWN output extraction
  // in its registry entry, because the output key is step-type-specific —
  // `convertImage` returns `{ blob }` (SINGULAR). Without this branch the
  // native `$type` filter below skips every registered step and its
  // result is unreachable: the caller is charged, the workflow reaches
  // `succeeded`, and `imageUrls` is absent on every poll.
  //
  // 🔴 ADDITIVE BY CONSTRUCTION. A registry entry may not claim one of the
  // natively-extracted `$type` values (`NATIVELY_EXTRACTED_STEP_TYPES`,
  // enforced at registry load), so this branch cannot shadow the customComfy /
  // textToImage / imageGen / comfy behaviour below — it only reaches `$type`s
  // that used to be dropped.
  const registeredStep = getStepByOrchestratorType(step.$type);
  if (registeredStep) {
    // 🔴 POSTURE-GATED, and this is the THIRD enforcement of the one
    // media-XOR-text rule (`stepOutputShape`), not a redundant null check. A
    // text-posture step publishes through `attachModeratedStepTextOutputs`
    // and ONLY through it; `StepOutputMedia.url` is a bare string that reaches
    // this array without ever meeting the scan, so reading a media extractor
    // off a text entry is exactly the smuggling channel the registry's
    // clause 8-ii and `TextOutputSurface.extractOutput?: never` exist to
    // close. Keying on the POSTURE rather than on `extractOutput != null`
    // means this holds even if a future cast puts one there.
    if (postureProducesMedia(registeredStep.moderationPosture)) {
      for (const entry of registeredStep.extractOutput?.(step) ?? []) {
        media.push(slotFromMedia(entry));
      }
    }
    return { media, trainedEpochs, model3d: [] };
  }
  // 🔴 THE CONSTANT, NOT A RESTATED TRIPLE. The false branch of this test used
  // to `continue` — dropping the step silently — and now forwards the step's
  // output to the app, so a fifth native `$type` added to
  // `NATIVELY_EXTRACTED_STEP_TYPES` without editing a literal in THIS file
  // would start publishing that type's output through the unmoderated
  // pass-through channel. Reading the constant removes the second edit.
  if (!NATIVELY_EXTRACTED_STEP_TYPES.includes(step.$type)) {
    // A PASS-THROUGH step (`kind:'step'` with a bare `$type`): not native, not
    // registered, so there is no declared extractor to ask.
    //
    // 🔴 GATED ON "THIS BRIDGE SUBMITTED IT", NOT ON "the `$type` is
    // unrecognised". Those are different sets: an unrecognised `$type` is
    // anything nobody extracts, which includes a step the ORCHESTRATOR put on
    // the workflow. Forwarding one of those would publish a platform step's
    // output to an app through a channel with no moderation posture, and it
    // would do it for `textToImage` and `customComfy` workflows too — neither
    // of which this arm has anything to do with. `bridgeSubmitted` is the
    // caller's answer to "did this bridge submit this step": the server-stamped
    // `BLOCK_STEP_NAME` for a single-step submit, or membership of the name
    // list a `kind:'workflow'` submit recorded on the workflow's metadata. Both
    // are echoed back by the orchestrator. Anything else keeps the pre-existing
    // behaviour: dropped.
    //
    // 🔴 THE BLOBS GO TO `imageUrls`, NOT TO `stepOutputs` (an unapproved training
    // run's go to neither). That keeps every image this arm produces on the one
    // channel the publish path and the per-viewer gated read already own; see `stepOutputs` in
    // `schema/blocks/workflow.schema`. A training checkpoint goes to NEITHER —
    // `splitPassThroughStep` drops it.
    if (!bridgeSubmitted) return { media, trainedEpochs, model3d: [] };
    const split = splitPassThroughStep(
      step.$type,
      (step as unknown as { output?: unknown }).output
    );
    if (split.truncated > 0) recordOutputTruncated(split.truncated);
    for (const m of split.slots) media.push(m);
    return {
      media,
      rest: split.rest,
      trainedEpochs: split.trainedEpochs,
      model3d: split.model3d,
    };
  }
  for (const entry of nativeStepOutputMedia(step)) media.push(entry);
  return { media, trainedEpochs, model3d: [] };
}

/**
 * The media a NATIVELY extracted step (`NATIVELY_EXTRACTED_STEP_TYPES`)
 * produced — the ONE read both `extractSnapshotStep` and `projectAppWorkflow`
 * use for those `$type`s.
 *
 * Output key per `$type` comes from `NATIVE_STEP_OUTPUT_KEY`.
 *
 * The availability + non-empty-url filter is `mediaSlotsFromBlobs`, the slot form of the
 * `mediaFromBlobs` the registry entries use: a blob the orchestrator has not made
 * available yet (pending) is dropped, and a BLOCKED one keeps its position as a slot
 * with a `blockedReason` and no url a block is given.
 */
function nativeStepOutputMedia(step: { $type: string; output?: unknown }): StepOutputSlot[] {
  const key = (NATIVE_STEP_OUTPUT_KEY as Record<string, 'images' | 'blobs' | undefined>)[
    step.$type
  ];
  if (!key) return [];
  const output = step.output as
    | Partial<Record<'images' | 'blobs', OrchestratorBlobLike[] | null>>
    | null
    | undefined;
  return mediaSlotsFromBlobs(output?.[key]);
}

/** `step_type` label for a pass-through step: its `$type` is app-supplied, an open set. */
export const SUCCEEDED_WITHOUT_MEDIA_PASSTHROUGH_LABEL = 'passthrough';
/** `step_type` label when the empty media steps span more than one label. */
export const SUCCEEDED_WITHOUT_MEDIA_MIXED_LABEL = 'mixed';

/**
 * The `step_type` label for `civitai_app_block_succeeded_without_media_total`
 * when a SUCCEEDED workflow has at least one bridge-submitted MEDIA step that
 * itself succeeded and produced no media of its own; `null` otherwise. This is
 * the #8132 defect shape: a `comfy` step succeeded, the viewer was charged, and
 * no media reached the block because the extractor read the wrong output key.
 *
 * 🔴 PER MEDIA STEP, NOT PER WORKFLOW. What sibling steps delivered does not
 * matter: a `chatCompletion` step that released text next to a `textToImage`
 * step that produced no images IS counted, because the images the viewer paid
 * for are still missing. Each step's own media is read with
 * `extractSnapshotStep`, the extractor `snapshotFromWorkflow` uses, so "no
 * media" here means exactly "nothing this step put on the snapshot".
 *
 * MEDIA STEPS. Only a step this bridge submitted and the snapshot extracts:
 * a `kind:'workflow'` member, a native `$type`, a registered `$type`, or a
 * pass-through step stamped `BLOCK_STEP_NAME`. Then:
 *   - a registered step counts only when its moderation posture produces MEDIA
 *     (`postureProducesMedia`); a text-posture step (`chatCompletion`) never
 *     does, so a text-only workflow is never counted;
 *   - a native `$type` (`NATIVELY_EXTRACTED_STEP_TYPES`) is always a media step;
 *   - a PASS-THROUGH step has no posture, so whether it should produce media is
 *     unknown. It is counted only when it produced NOTHING: no media and no
 *     non-blob output (which would reach `stepOutputs`);
 *   - skipped: training `$type`s (they deliver epochs, and only after
 *     moderation approves them), `suppressOutput` members, `repeat` parents
 *     (their children are members in their own right), steps the bridge did not
 *     submit, and steps whose own status is not `succeeded`.
 *
 * 🔴 BOUNDED LABELS. `stepType`: a native or registered `$type` is code-owned
 * and is used as-is; every pass-through `$type` (app-chosen, an open set)
 * collapses to `passthrough`; more than one distinct label is `mixed`.
 * `reason`, per empty media step, re-running the same extractor over
 * `withEveryBlobSurfaceable(output)`:
 *   - `absent`: the location the extractor reads held no blobs at all. This is
 *     the #8132 defect shape (blobs under a key nobody reads) and the one to
 *     alert on;
 *   - `unavailable`: blobs were there but `mediaFromBlobs` dropped every one
 *     (pending, withheld or blocked by the orchestrator). The viewer still saw
 *     nothing, but this is not necessarily a bridge bug.
 * Several empty steps with different reasons report `absent`.
 */
export function classifySucceededWithoutMedia(
  workflow: Workflow,
  snapshot: Pick<BlockWorkflowSnapshot, 'status'>
): { stepType: string; reason: AppBlockSucceededWithoutMediaReason } | null {
  if (snapshot.status !== 'succeeded') return null;
  const submittedSteps = readBlockWorkflowSteps(workflow.metadata);
  const labels = new Set<string>();
  let anyAbsent = false;
  for (const step of workflow.steps ?? []) {
    if (step.status !== 'succeeded') continue;
    const member = submittedSteps ? resolveBlockWorkflowStep(submittedSteps, step.name) : null;
    if (member && (member.suppressOutput || isRepeatStepType(step.$type))) continue;
    if (canonicalTrainingStepType(step.$type) !== null) continue;
    const registered = getStepByOrchestratorType(step.$type);
    let label: string;
    if (registered) {
      if (!postureProducesMedia(registered.moderationPosture)) continue;
      label = step.$type;
    } else if (NATIVELY_EXTRACTED_STEP_TYPES.includes(step.$type)) {
      label = step.$type;
    } else if (member || step.name === BLOCK_STEP_NAME) {
      label = SUCCEEDED_WITHOUT_MEDIA_PASSTHROUGH_LABEL;
    } else {
      continue;
    }
    const own = extractSnapshotStep(step, true);
    const delivered =
      own.media.some((m) => m.blockedReason === null) ||
      (label === SUCCEEDED_WITHOUT_MEDIA_PASSTHROUGH_LABEL && own.rest !== undefined);
    if (delivered) continue;
    labels.add(label);
    // Same extractor, over a copy with every blob made surfaceable: media now
    // means blobs WERE at the expected location but all withheld.
    const probed = extractSnapshotStep(
      {
        ...step,
        output: withEveryBlobSurfaceable((step as unknown as { output?: unknown }).output),
      } as typeof step,
      true
    );
    if (!probed.media.some((m) => m.blockedReason === null)) anyAbsent = true;
  }
  if (labels.size === 0) return null;
  return {
    stepType: labels.size === 1 ? [...labels][0] : SUCCEEDED_WITHOUT_MEDIA_MIXED_LABEL,
    // The defect signal wins: one absent step makes the workflow `absent`.
    reason: anyAbsent ? 'absent' : 'unavailable',
  };
}

/** True when the workflow carries a training step THIS bridge submitted. */
function hasBlockTrainingStep(workflow: Workflow): boolean {
  const submittedSteps = readBlockWorkflowSteps(workflow.metadata);
  return (workflow.steps ?? []).some(
    (step) =>
      canonicalTrainingStepType(step.$type) !== null &&
      (step.name === BLOCK_STEP_NAME ||
        (submittedSteps !== null && resolveBlockWorkflowStep(submittedSteps, step.name) !== null))
  );
}

const isPositiveInteger = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0;

/**
 * The model a block-run training workflow became, from the ids the training
 * publish wizard merges into the workflow's metadata (`stampWorkflowDraftModel`,
 * `stampWorkflowPublished`). Gated on a block-submitted training step so a stray
 * `modelId` on any other workflow's metadata is never reported as its model.
 */
function readBlockPublishedModel(workflow: Workflow): BlockPublishedModel | undefined {
  if (!hasBlockTrainingStep(workflow)) return undefined;
  const meta = (workflow.metadata ?? {}) as Record<string, unknown>;
  if (!isPositiveInteger(meta.modelId) || !isPositiveInteger(meta.modelVersionId)) {
    return undefined;
  }
  return {
    modelId: meta.modelId,
    modelVersionId: meta.modelVersionId,
    published: meta.published === true,
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
  return `${APP_BLOCK_TAG_PREFIX}${appId}`;
}

/**
 * The per-INSTANCE tag. Server-stamped at submit (`buildWorkflowTags`) from the
 * VERIFIED token's `blockInstanceId`, never client input. Same single-source rule
 * as `appBlockTag`: the stamp and `assertBlockWorkflowTaggedForInstance` both call
 * this, so they cannot desync.
 */
export function appBlockInstanceTag(blockInstanceId: string): string {
  return `${APP_BLOCK_TAG_PREFIX}instance:${blockInstanceId}`;
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
 *           RESTRICTED outputs are left out, so this is a convenience view and
 *           NOT an index space — indexes are positions in `outputs`.
 *   cost:   the workflow's realized/estimated buzz total, or null when absent.
 *   status: the block-contract status (see ORCH_STATUS_MAP) — the orchestrator's
 *           unassigned/preparing/scheduled all collapse to `pending`, and a
 *           `succeeded` workflow still holding an output for its rating reads
 *           `processing` ({@link appWorkflowStatus}).
 *   trainedEpochs: OPTIONAL, same value and rule as the snapshot field — see
 *           `BlockWorkflowSnapshot.trainedEpochs`. Absent unless an approved
 *           pass-through training run has a ready checkpoint.
 *   publishedModel: OPTIONAL, same value and rule as the snapshot field — see
 *           `BlockWorkflowSnapshot.publishedModel`. Absent on every other item.
 *   model3dOutputs: OPTIONAL, same value and rule as the snapshot field — see
 *           `BlockWorkflowSnapshot.model3dOutputs`. Every url is also in `images`.
 *   outputs: OPTIONAL, same value and rule as `BlockWorkflowSnapshot.outputs`: every
 *           available output in order, RESTRICTED ones in position with no url.
 *           🔴 `outputs` IS THE INDEX SPACE: publish / post `imageIndexes` and
 *           persist's `imageIndex` are positions in it (see
 *           `projectAppWorkflowWithPositions`). `images` drops restricted outputs
 *           and is a convenience view, NOT for indexing.
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
  trainedEpochs?: TrainedEpoch[];
  publishedModel?: BlockPublishedModel;
  model3dOutputs?: BlockModel3dOutput[];
  outputs?: BlockWorkflowOutput[];
  /** Same value and rule as `BlockWorkflowSnapshot.ratingPending`. */
  ratingPending?: true;
};

/**
 * Pure projection Workflow → AppWorkflow. No IO, no throws — safe to map over a
 * whole page of LIST results. See `AppWorkflow` for the field-by-field contract.
 *
 * 🔴 `view` IS REQUIRED for the same reason as on `snapshotFromWorkflow`: the
 * calling token's maturity ceiling decides which outputs are RESTRICTED, and a
 * restricted output's url is in neither `images` nor `model3dOutputs`. Every
 * consumer — the listing, the cancel reply, publish, post and persist — passes the
 * calling token's ceiling and serving rules, so the positions a block indexed are the
 * positions the server resolves its `imageIndexes` against.
 */
export function projectAppWorkflow(
  workflow: Workflow,
  view: BlockOutputView,
  opts?: { now?: number }
): AppWorkflow {
  return projectAppWorkflowWithPositions(workflow, view, opts).workflow;
}

/**
 * One output POSITION of a workflow — the index space of `AppWorkflow.outputs`, and the
 * index space every `imageIndexes` / `imageIndex` (publish, post, persist) addresses.
 * `image` is the server-side media at that position; it carries a url even when
 * `output` is restricted, so it must NEVER be handed to a block — callers check
 * `output` first and refuse a restricted position.
 */
export type AppWorkflowOutputPosition = { image: AppWorkflowImage; output: BlockWorkflowOutput };

/**
 * {@link projectAppWorkflow}, plus the server-side media at each output position.
 *
 * 🔴 POSITIONS ARE STABLE. Position `n` is the `n`-th available output, whatever its
 * rating — a restricted output keeps its slot — so a rating that lands after the app
 * read the list never moves an index. The filtered `images` list is a convenience view
 * and is NOT an index space.
 */
export function projectAppWorkflowWithPositions(
  workflow: Workflow,
  view: BlockOutputView,
  /** `now`: the clock for the rating hold's deadline ({@link isRatingHoldExpired}); tests only. */
  opts?: { now?: number }
): { workflow: AppWorkflow; positions: AppWorkflowOutputPosition[] } {
  const status = orchestratorBlockStatus(workflow);
  const now = opts?.now ?? Date.now();
  // Every output position (surfaceable and blocked), in order, and its verdict —
  // classified PER STEP, the same call `snapshotFromWorkflow` makes.
  const available: StepOutputSlot[] = [];
  const outputs: BlockWorkflowOutput[] = [];
  const add = (step: Parameters<typeof classifyOutputs>[1], slots: readonly StepOutputSlot[]) => {
    available.push(...slots);
    outputs.push(...classifyOutputs(slots, step, workflow, view));
  };
  const trainedEpochs: TrainedEpoch[] = [];
  const model3dOutputs: BlockModel3dOutput[] = [];
  // Mirrors `snapshotFromWorkflow`'s member-step handling.
  const submittedSteps = readBlockWorkflowSteps(workflow.metadata);
  for (const step of workflow.steps ?? []) {
    const member = submittedSteps ? resolveBlockWorkflowStep(submittedSteps, step.name) : null;
    if (member && isRepeatStepType(step.$type)) continue;
    if (member?.suppressOutput) {
      // Still report a suppressed training step's ready epochs: `suppressOutput`
      // hides images, and a checkpoint is never one.
      if (canonicalTrainingStepType(step.$type) !== null) {
        trainedEpochs.push(
          ...splitPassThroughStep(step.$type, (step as unknown as { output?: unknown }).output)
            .trainedEpochs
        );
      }
      continue;
    }
    // A REGISTERED step type — same registry-declared extraction the snapshot
    // uses, so a capability is retrievable on BOTH read surfaces from ONE
    // declaration. Without it `queryAppWorkflows` returns `images: []` for a
    // step the app paid for. See the snapshotFromWorkflow branch for why this is
    // additive and cannot shadow the native `$type`s below.
    const registeredStep = getStepByOrchestratorType(step.$type);
    if (registeredStep) {
      // 🔴 Same posture gate as `snapshotFromWorkflow` — see the note there.
      // This projection matters MORE, not less: `AppWorkflow` has no text field
      // at all, so it is not wrapped by `attachModeratedStepTextOutputs`, and
      // `images[].url` would be the only channel a text step could reach it
      // through.
      if (!postureProducesMedia(registeredStep.moderationPosture)) continue;
      // The registry hands over the RAW rating string, never a bitflag, so the
      // mapping stays in one place (`toAppWorkflowImage`).
      add(step, (registeredStep.extractOutput?.(step) ?? []).map(slotFromMedia));
      continue;
    }
    if (!NATIVELY_EXTRACTED_STEP_TYPES.includes(step.$type)) {
      // A PASS-THROUGH step. Same split as `snapshotFromWorkflow`, and it MUST be
      // here too: this projection is what `resolveOwnedWorkflowOutputs` reads, so
      // a pass-through image absent here is an image the viewer can see in their
      // own block and can never publish — which would route it AROUND the
      // per-viewer gated read rather than through it.
      //
      // The non-media half is deliberately DROPPED, not forwarded: `AppWorkflow`
      // is the cross-surface queue contract and exists to hand a block nothing
      // but images, cost and status. The one addition is `trainedEpochs`, taken
      // from the same split the snapshot uses, so a block listing its runs can
      // offer an approved one to the publish wizard.
      //
      // Same "this bridge submitted it" gate as `snapshotFromWorkflow` — see the
      // note there for why "unrecognised `$type`" is the wrong set.
      if (step.name !== BLOCK_STEP_NAME && !member) continue;
      const split = splitPassThroughStep(
        step.$type,
        (step as unknown as { output?: unknown }).output
      );
      if (split.truncated > 0) recordOutputTruncated(split.truncated);
      trainedEpochs.push(...split.trainedEpochs);
      model3dOutputs.push(...split.model3d);
      add(step, split.slots);
      continue;
    }
    // A NATIVE `$type` — `output.images` or `output.blobs` per `$type`; see
    // `nativeStepOutputMedia`.
    add(step, nativeStepOutputMedia(step));
  }
  // `outputs` keeps every position, `images` only the unrestricted ones, each with the
  // url the app is given for it.
  const images: AppWorkflowImage[] = [];
  available.forEach((m, i) => {
    const output = outputs[i];
    if (isUnrestrictedOutput(output)) images.push({ ...toAppWorkflowImage(m), url: output.url });
  });
  const total = workflow.cost?.total;
  const publishedModel = readBlockPublishedModel(workflow);
  const labels = labelsFor(model3dOutputs, available, outputs);
  return {
    workflow: {
      // A real LIST/GET item always carries an id; empty-string only if the
      // orchestrator ever omits it (never for a persisted workflow).
      workflowId: workflow.id ?? '',
      status: appWorkflowStatus(workflow, status, outputs, now),
      images,
      cost: typeof total === 'number' ? total : null,
      createdAt: workflow.createdAt,
      ...(trainedEpochs.length > 0 ? { trainedEpochs } : {}),
      ...(publishedModel ? { publishedModel } : {}),
      ...(labels.length > 0 ? { model3dOutputs: labels } : {}),
      ...(outputs.length > 0 ? { outputs } : {}),
      ...(anyPending(outputs) ? { ratingPending: true as const } : {}),
    },
    positions: available.map((m, i) => ({ image: toAppWorkflowImage(m), output: outputs[i] })),
  };
}

function toAppWorkflowImage(media: StepOutputSlot): AppWorkflowImage {
  return {
    url: media.url,
    width: media.width,
    height: media.height,
    // Map the orchestrator's string rating to the numeric civitai browsing-
    // level bitflag via the CANONICAL helper (handles the SFW 'g' the raw map
    // lacks + all of pg/pg13/r/x/xxx, fail-closed to PG for an unexpected
    // string — so it can't drift from the platform mapping). null ONLY for the
    // genuinely-unrated sentinel ('na') / unset.
    nsfwLevel:
      media.nsfwLevel && media.nsfwLevel !== 'na'
        ? nsfwLevelFromContentRating(media.nsfwLevel)
        : null,
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
      flags: true,
      meta: true,
      generationCoverage: { select: { covered: true, coveredNext: true } },
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
      ...coveragePair(version.generationCoverage, await nextCoverageEnabled()),
      modelUserId: version.model.userId,
      modelType: version.model.type,
      flags: version.flags,
      modelVersionAlias:
        (version.meta as { generationAlias?: unknown } | null)?.generationAlias ?? null,
    },
  };
}

// Page-LoRA (Increment 1): the model types accepted as a page additional
// resource. v1 is LoRA-only — the generator's LoRA family is LORA + LoCon +
// DoRA (the same set the generation resource picker groups as "LoRA"; see
// basemodel.constants supportMap). VAE / embeddings / etc. also flow through
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
      flags: true,
      meta: true,
      generationCoverage: { select: { covered: true, coveredNext: true } },
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
      ...coveragePair(version.generationCoverage, await nextCoverageEnabled()),
      modelUserId: version.model.userId,
      modelType: version.model.type,
      flags: version.flags,
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
 * THE single place the two source-image wire shapes collapse into one.
 *
 * `sourceImage` (singular) is a DEPRECATED ALIAS — the published developer docs
 * and `@civitai/app-sdk` still ship it — and `sourceImages` is the current
 * field. Everything downstream of this function sees ONLY an array, so no code
 * path can accidentally handle one shape and miss the other.
 *
 * Supplying both is rejected at the WIRE schema (ambiguous), so it cannot reach
 * here; the `sourceImages`-first order below is defensive, not a preference.
 * Returns an empty array when the body carries neither — that is the txt2img
 * case. An explicitly EMPTY `sourceImages: []` never reaches here either: the
 * schema's `.min(1)` rejects it rather than let it degrade into a txt2img
 * generation the caller did not ask for.
 */
export function normalizeBlockSourceImages(
  body: Extract<BlockWorkflowBody, { kind: 'textToImage' }>
): BlockSourceImage[] {
  if (body.sourceImages?.length) return body.sourceImages;
  if (body.sourceImage) return [body.sourceImage];
  return [];
}

/**
 * Resolve which image graph workflow a block body maps to when combined with the
 * checkpoint's ecosystem:
 *   - no source image + txt2img-capable eco    → `txt2img`
 *   - no source image + EDIT-ONLY ecosystem    → BAD_REQUEST
 *   - source image + SD-family ecosystem       → `img2img`      (Image Variations)
 *   - source image + edit-capable ecosystem    → `img2img:edit` (OpenAI / Qwen /
 *                                                Flux Kontext / … — EDIT_IMG_IDS)
 *   - source image + neither variant available → BAD_REQUEST
 *
 * The EDIT-ONLY rejection is the ecosystem-level half of the "silently produced
 * the wrong graph" guard (see `assertCheckpointVersionSupportsWorkflow` for the
 * VERSION-level half, which is what actually bites today). An ecosystem that
 * supports `img2img:edit` but NOT `txt2img` cannot honour a bare body at all;
 * without this it would build a txt2img graph the ecosystem has no route for.
 * No image ecosystem is edit-only in the CURRENT config (every member of
 * EDIT_IMG_IDS is also in TXT2IMG_IDS), so this is a fail-closed guard against
 * a future edit-only ecosystem, derived from `isWorkflowAvailable` rather than
 * from a hardcoded list so it can never go stale.
 *
 * Variant selection is DETERMINISTIC via `isWorkflowAvailable` (the same
 * availability check the generation graph uses) — it never leans on
 * `generationHub.parse` auto-correcting a mis-routed ecosystem (the #3127 bug
 * class: `correct` policies rewrite the value during the resolve pass, silently
 * unsupported ecosystem to a supported one and returning a mis-routed graph as
 * success). `ecosystemId` is the checkpoint's resolved ecosystem id; when it is
 * omitted (unrecognized base model) a source-image body is rejected fail-closed.
 */
export function resolveBlockImageWorkflowType(
  body: Extract<BlockWorkflowBody, { kind: 'textToImage' }>,
  ecosystemId?: number
): BlockImageWorkflowType {
  // 🔴 UNION OF TWO CHANGES — the CONDITION comes from the sourceImages[] work,
  // the guard BODY from the edit-only work. Reading the NORMALIZED array (not the
  // deprecated singular `body.sourceImage`) is load-bearing: an array-only body
  // has `sourceImage` undefined, so the old literal check would route it to
  // `txt2img`, silently DROP the images, and bill the caller for a text-to-image
  // generation. That is the exact silent-wrong-answer class both changes exist to
  // close, so it must not be reintroduced by a conflict resolution.
  if (normalizeBlockSourceImages(body).length === 0) {
    if (
      ecosystemId != null &&
      !isWorkflowAvailable('txt2img', ecosystemId) &&
      isWorkflowAvailable('img2img:edit', ecosystemId)
    ) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          "this checkpoint's ecosystem is edit-only — it supports img2img:edit but not " +
          'txt2img. Send a `sourceImage` to run an edit, or pick a text-to-image checkpoint.',
      });
    }
    return 'txt2img';
  }
  if (ecosystemId != null && isWorkflowAvailable('img2img', ecosystemId)) return 'img2img';
  if (ecosystemId != null && isWorkflowAvailable('img2img:edit', ecosystemId))
    return 'img2img:edit';
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      'img2img (source image) is not supported for this checkpoint — its ecosystem supports ' +
      'neither img2img (SD-family) nor img2img:edit (edit-capable: OpenAI/Qwen/Flux Kontext/…)',
  });
}

/**
 * Reject a checkpoint version the target workflow does not offer, when the
 * ecosystem scopes its checkpoint versions BY WORKFLOW.
 *
 * THE BUG THIS CLOSES. Several image ecosystems ship DIFFERENT checkpoint
 * versions per workflow (`checkpointDef({ workflowVersions })` in
 * qwen-graph / boogu-graph / mage-flow-graph). Qwen model 2268063, for example,
 * hosts BOTH `2558804` ("Image Edit 2511", offered only on `img2img:edit`) and
 * `2552908` (offered only on `txt2img`).
 *
 * The block bridge picks its workflow purely from `sourceImage` presence, so a
 * body naming the EDIT version with no `sourceImage` resolved to `txt2img` —
 * and the generation graph did NOT reject it. It returned success with a
 * DIFFERENT checkpoint: `model.id` 2558804 → 2552908. The caller was billed,
 * got images, and never learned about the swap.
 *
 * THE MECHANISM is the `modelLocked` clamp in `checkpointDef`'s `correct`
 * (`shared/form-graph/generation/checkpoint.ts`): on a `modelLocked` ecosystem,
 * ANY id not in the CURRENT workflow's visible version list is replaced with that
 * workflow's `defaultModelId` — regardless of its position in the sibling list,
 * or of whether the ecosystem has ever heard of it.
 *
 * It is NOT an index-equivalent remap. One family has that — MageFlow, via its own
 * `workflow_version_remap` `correct`, which runs first and pre-empts the clamp —
 * and the distinction decides which inputs are affected, so it is pinned by an
 * executed discriminator rather than described (the `SILENTLY SUBSTITUTES` tests
 * in `workflow.service.test.ts` choose ids where the two rules predict differently).
 *
 * Nothing in the response, the snapshot, or the `block_workflows` read-model
 * reveals the substitution, which makes it the worst available failure mode: a
 * successful-looking wrong answer.
 *
 * SCOPE — this guard deliberately closes only a SUBSET of that class: a version
 * that IS one of the ecosystem's workflow-scoped versions but belongs to a
 * DIFFERENT workflow, in the txt2img direction only. Two parts stay open:
 *
 *  - An UNRECOGNIZED id (a community checkpoint, a brand-new upload) on a
 *    `modelLocked` ecosystem is also clamped to the workflow default —
 *    `{ workflow: 'txt2img', ecosystem: 'Qwen', model: { id: 987654321 } }`
 *    returns success with `model.id` 2552908. It is NOT "left alone". MOST image
 *    ecosystems are `modelLocked`, so this is the wide part of the class, and
 *    rejecting it here would reject ids the graph is willing to run.
 *  - The reverse direction (a txt2img-only version sent WITH a `sourceImage`)
 *    is substituted the same way and is likewise not rejected here.
 *
 * The broader class is tracked in #3520. `resolveVersionWorkflowScope` is
 * already direction-agnostic, so flipping the reverse direction on is a
 * one-line change — held deliberately, not overlooked.
 */
export function assertCheckpointVersionSupportsWorkflow(opts: {
  ecosystem: string;
  ecosystemId?: number;
  workflow: BlockImageWorkflowType;
  checkpointVersionId: number;
}): void {
  const { ecosystem, ecosystemId, workflow, checkpointVersionId } = opts;

  // Only the image workflows the block bridge can produce are candidates, and
  // only those the ecosystem actually supports — asking about a route the
  // ecosystem has no config for would just yield noise.
  const candidateWorkflows = BLOCK_IMAGE_WORKFLOW_TYPES.filter(
    (w) => ecosystemId != null && isWorkflowAvailable(w, ecosystemId)
  );

  const scope = resolveVersionWorkflowScope({
    ecosystem,
    workflow,
    candidateWorkflows,
    versionId: checkpointVersionId,
  });
  if (scope.kind !== 'wrong-workflow') return;

  const isEditOnly = scope.offeredFor.every((w) => w.startsWith('img2img'));
  const remedy = isEditOnly
    ? 'send a `sourceImage` to run it as an image edit'
    : `send this version on ${scope.offeredFor.join(' / ')} instead`;
  const alternative = scope.suggestedVersionId
    ? `, or use modelVersionId ${scope.suggestedVersionId} for ${workflow}`
    : '';

  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      `modelVersion ${checkpointVersionId} is not available for '${workflow}' on the ` +
      `${ecosystem} ecosystem — it is offered for ${scope.offeredFor.join(' / ')} only. ` +
      `Either ${remedy}${alternative}.`,
  });
}

/**
 * Enforce the PER-ECOSYSTEM source-image cap.
 *
 * The cap is not a constant — it is declared per ecosystem in the graph's own
 * `imagesDef({ min, max })` and ranges 1–10. A flat constant would over-allow the
 * 1-image ecosystems and under-allow the widest ones, so `getImagesLimit` reads the
 * real graph config instead.
 *
 * WHY REJECT RATHER THAN LET THE GRAPH HANDLE IT: `imagesDef`'s INPUT
 * transform AND its `correct` truncate — an over-cap array is silently
 * TRUNCATED, and the caller is billed for a generation conditioned on fewer
 * images than it sent, with nothing in the response saying so. Same
 * silent-wrong-answer class the ecosystem/variant guard above exists to stop.
 *
 * FAIL CLOSED when the limit cannot be determined: `getImagesLimit` returns
 * `undefined` for a pair with no images node, which for a resolved img2img
 * workflow means our routing and the graph's disagree. Rejecting is correct
 * there — proceeding would hand the graph an `images` array it has no node for.
 * The ecosystem/variant guard upstream makes that unreachable today (and a test
 * enumerates every img2img-capable ecosystem to prove each one HAS a readable
 * limit), so this is defense-in-depth against the two guards drifting apart —
 * exported so it can be exercised directly rather than left unverified.
 *
 * The MINIMUM is deliberately NOT re-checked here. Every image workflow's
 * `imagesDef` has `min: 1` today, and we only call this with `count >= 1`; if
 * a future ecosystem raises its minimum, the graph's own OUTPUT schema
 * (`.min(min, …)`) rejects LOUDLY
 * during `safeParse` — that failure mode is already an error, not a silent
 * wrong answer, so duplicating it here would only add a second place to drift.
 */
export function assertSourceImageCount(opts: {
  ecosystem: string;
  workflow: BlockImageWorkflowType;
  count: number;
}): void {
  const { ecosystem, workflow, count } = opts;
  const limit = getImagesLimit(ecosystem, workflow);
  if (!limit) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `workflow '${workflow}' does not accept source images on the ${ecosystem} ecosystem`,
    });
  }
  if (count > limit.max) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        `too many source images: ${count} sent, but the ${ecosystem} ecosystem accepts at most ` +
        `${limit.max} for '${workflow}'`,
    });
  }
}

/**
 * Translate the block's narrow body into the platform's generation-graph
 * `input` (the flat `Record<string, unknown>` shape `generateFromGraph` /
 * `createWorkflowStepsFromGraphInput` consume), for the IMAGE workflow class
 * (txt2img / img2img). Defaults are intentionally conservative (steps=25,
 * priority=low). An omitted sampler is the family's own default — see SAMPLER below.
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
    /**
     * `modelVersionId → ModelType` for every entry in `body.additionalResources`,
     * resolved by the caller (`resolvePageLoraGates` already reads each version).
     *
     * REQUIRED, not optional — an empty map is the correct value on a path that
     * accepts no additional resources (the MODEL branch rejects them outright).
     * Optional would let a future call site omit it, type-check cleanly, and
     * fail at runtime with a 500.
     *
     * ⚠️ That protection covers PRODUCTION call sites only. `tsconfig.json`
     * excludes `src/**\/__tests__/**`, so a test that omits this still compiles;
     * it fails at runtime instead. Keep the fixtures supplying it.
     */
    additionalResourceTypes: ReadonlyMap<number, string>;
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
  // HERE rather than lean on the graph: the hub's `correct` policies rewrite during
  // the resolve pass, BEFORE validation, so an unsupported checkpoint
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

  // Version-level guard (see assertCheckpointVersionSupportsWorkflow). Placed
  // HERE rather than inside resolveBlockImageWorkflowType so it covers BOTH the
  // derive path and the `workflowTypeOverride` seam, and because the CHECKPOINT
  // version (not `body.modelVersionId`) is what the graph anchors on — for a
  // LoRA-bound install those differ.
  //
  // SCOPED TO txt2img ON PURPOSE. The symmetric case — a txt2img-only version
  // sent WITH a `sourceImage`, which today is silently substituted the same way
  // in the other direction — is left alone in this change: it is a separate
  // behaviour change with its own blast radius, and no live traffic could be
  // measured either way (the submitted body is not retained anywhere; see the
  // PR description). Flipping this to guard every resolved workflowType is a
  // one-line follow-up — the helper is already direction-agnostic.
  if (workflowType === 'txt2img') {
    assertCheckpointVersionSupportsWorkflow({
      ecosystem,
      ecosystemId: ecoRecord?.id,
      workflow: workflowType,
      checkpointVersionId: resolved.checkpointVersionId,
    });
  }

  const dims = defaultDimensions(resolved.checkpointBaseModel);
  const width = body.params.width ?? dims.width;
  const height = body.params.height ?? dims.height;

  // LoRAs only — the checkpoint is the `model` anchor, not a `resources` entry.
  //
  // 🔴 `model.type` IS REQUIRED, NOT DECORATIVE (issue #4159). The generation
  // graph's `resources` node validates its OUTPUT against `resourceSchema`,
  // which requires `model: { type: string }` — the loose `{ id }` INPUT schema
  // is not what the parse is graded on. Emitting `{ id, strength }` therefore
  // failed EVERY workflow carrying an additional resource with
  // `Validation failed: resources: Invalid input: expected object, received
  // undefined`, i.e. a 400 for every LoRA that survived the compatibility gate.
  // (The `model` anchor escaped this because the checkpoint node's own input
  // schema fills `model: { type: 'Checkpoint' }` in a transform; the resources
  // node has no such transform.) The on-site generator form never hit it either
  // — its state already holds fully-shaped resource objects.
  //
  // The type is the resolved Prisma `ModelType`, NOT a guess: the bound model's
  // comes from the caller's own `resolveBlockVersionContext`, and each
  // additional resource's from the per-item version read the router already
  // performs in `resolvePageLoraGates`. No second enrichment is introduced.
  //
  // ⚠️ SCOPE OF THE `model.type` VALUE, stated precisely so nobody over-reads it.
  // On THIS path the value is inert for the orchestrator payload today:
  // `stable-diffusion.handler.ts` folds `resources` + `vae` into one
  // AIR-keyed `additionalNetworks` map carrying only `{ strength }`, and
  // `splitResourcesByType` runs on ENRICHED resources elsewhere, never on this
  // graph input. So a wrong type here could not mis-route or mis-bill TODAY —
  // the schema requirement is what makes it load-bearing, and correctness of
  // the value is future-proofing for the deferred VAE/embedding increment,
  // which does slot by `model.type`.
  const resources: Array<{ id: number; strength: number; model: { type: string } }> = [];
  // The bound model is itself a LoRA (LoRA install) — push it as a network.
  // A Checkpoint-bound install has no additional network here.
  if (resolved.modelType !== 'Checkpoint') {
    // 🔴 BOUND THE SURFACE THIS FIX REVIVES. Before the `model.type` fix every
    // non-Checkpoint-bound request failed graph validation, so in practice
    // blocks generation only ever worked for Checkpoint-bound blocks. Reviving
    // the push without a type rule would let ANY bound type — Upscaler, VAE —
    // proceed to whatIf and to billing as an additional network, gated only by
    // coverage/entitlement. Those types have their OWN singleton graph nodes,
    // so `resources` is the wrong slot for them by the platform's own routing
    // table (`SINGLETON_SLOT_BY_MODEL_TYPE`) — read through
    // `isSingletonSlotResource` rather than restated, so this cannot drift from
    // it. Fail closed with a legible message instead. This cannot regress a
    // working flow: every one of these requests 400s on `main` today.
    if (isSingletonSlotResource(resolved.modelType)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          `a block bound to a ${resolved.modelType} model cannot generate — ` +
          `bind it to a checkpoint or an additional-network resource`,
      });
    }
    resources.push({
      id: body.modelVersionId,
      strength: 1,
      model: { type: resolved.modelType },
    });
  }

  // Page-LoRA (Increment 1): fan each caller-supplied additional resource into
  // `resources` as { id, strength, model:{type} }. DEDUPE against the checkpoint
  // anchor AND the bound-model network already present so a LoRA that coincides
  // with the anchor isn't double-billed / double-counted in strength. A LoRA that
  // duplicates another LoRA keeps its first occurrence (first-wins).
  if (body.additionalResources?.length) {
    const seen = new Set<number>([resolved.checkpointVersionId, ...resources.map((r) => r.id)]);
    for (const r of body.additionalResources) {
      if (seen.has(r.modelVersionId)) continue;
      seen.add(r.modelVersionId);
      // FAIL-CLOSED rather than defaulting to 'LORA'. Today every accepted
      // additional resource is in the LoRA family and all three types share the
      // graph's catch-all `resources` slot, so a default would be invisible —
      // and (see the note above) the value is inert on the orchestrator payload,
      // so it could not mis-route or mis-bill today either. The reason to refuse
      // a default is the deferred VAE/embedding increment, which DOES slot by
      // `model.type` (`SINGLETON_SLOT_BY_MODEL_TYPE`): a default would go on
      // silently working until the day it silently didn't. A missing entry is a
      // server-side wiring bug, never anything a caller can provoke.
      const modelType = resolved.additionalResourceTypes.get(r.modelVersionId);
      if (!modelType) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'additional resource type was not resolved',
        });
      }
      resources.push({ id: r.modelVersionId, strength: r.strength, model: { type: modelType } });
    }
  }

  const sampler =
    body.params.sampler ?? resolveDefaultSampler(ecosystem, resolved.checkpointVersionId);

  const input: Record<string, unknown> = {
    workflow: workflowType,
    ecosystem,
    model: { id: resolved.checkpointVersionId },
    resources,
    prompt: body.params.prompt,
    ...(body.params.negativePrompt != null ? { negativePrompt: body.params.negativePrompt } : {}),
    ...(body.params.cfgScale != null ? { cfgScale: body.params.cfgScale } : {}),
    // SAMPLER: an omitted sampler is the family default the generator preselects and
    // `GET /api/v1/blocks/generation-samplers` reports — one source (`resolveDefaultSampler`),
    // never a literal. A literal 'Euler' was silently swapped by the graph's `selectDef` in
    // families that do not offer it, and overrode the generator's default in the SD family,
    // which offers 'Euler' but preselects 'Euler a'.
    // No key at all when the family has no sampler control, or the catalog cannot say: the
    // graph then applies its own default (the same source the catalog reads).
    ...(sampler != null ? { sampler } : {}),
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
    // aspectRatio is OMITTED here. The graph's imagesDef reads
    // { url, width, height }; extra fields are stripped by its object parse.
    //
    // MULTI-IMAGE: the source images are the NORMALIZED array, so the singular
    // deprecated `sourceImage` and the array `sourceImages` produce identical
    // downstream shapes. The count is checked against the ECOSYSTEM's real cap
    // BEFORE emitting — the graph would otherwise silently truncate an over-cap
    // array (see assertSourceImageCount).
    const sourceImages = normalizeBlockSourceImages(body);
    if (sourceImages.length) {
      assertSourceImageCount({ ecosystem, workflow: workflowType, count: sourceImages.length });
      input.images = sourceImages.map((img) => ({
        url: img.url,
        width: img.width,
        height: img.height,
      }));
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

/**
 * Orchestrator step name stamped on BOTH `kind:'step'` arms' submissions.
 *
 * 🔴 IT LIVES HERE, NOT IN `blocks.router`, BECAUSE THE EXTRACTORS READ IT. The
 * pass-through branch of `extractSnapshotStep` / `projectAppWorkflow` keys on
 * it to tell "a step THIS BRIDGE submitted" from "some other step that ended up
 * on the workflow", and a second copy of that literal is how the stamp and the
 * read stop agreeing. `WorkflowStep.name` is a REQUIRED field on the
 * orchestrator's response type, so the value we submit is the value that comes
 * back.
 */
export const BLOCK_STEP_NAME = 'block-step';

// Format a whole-second timeout as the orchestrator's `HH:MM:SS` step-timeout
// string (WorkflowStep.timeout). 180 → '00:03:00'.
export function formatStepTimeout(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/**
 * Wrap a recipe's customComfy step input into the `$type:'customComfy'` step,
 * STAMPING the resolved per-engine `stepTimeoutSeconds` as the step `timeout`
 * (formatted `HH:MM:SS`). That timeout is the ONLY deterministic per-job Buzz
 * bound the orchestrator offers: at `job.ExpireAt` the job is canceled and
 * billed for measured runtime, so worst-case Buzz = `ceil(timeout_s × 1)` =
 * the engine's `maxBuzz` (plan §5). This is what makes the post-paid path
 * bounded. v1.1: the timeout is PER ENGINE, so the caller resolves it from the
 * params (`recipe.budgetFor(params).stepTimeoutSeconds`) and threads it in — the
 * `maxBuzz` reserved against the caps and this timeout MUST move together.
 *
 * Sibling of `createBlockTextToImageStep` (blocks.router.ts) — but a customComfy
 * step is built by DIRECT object construction (the recipe's graph), NOT through
 * the generation-graph pipeline, so it needs none of that helper's
 * `createWorkflowStepsFromGraphInput` machinery.
 */
export function createBlockCustomComfyStep(
  input: CustomComfyStepInput,
  stepTimeoutSeconds: number
): CustomComfyStepTemplate {
  return {
    $type: 'customComfy',
    name: BLOCK_CUSTOM_COMFY_STEP_NAME,
    timeout: formatStepTimeout(stepTimeoutSeconds),
    input,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LONG-POLL BOUNDS for `blocks.pollWorkflow`.
//
// The orchestrator's `GET /v2/consumer/workflows/{id}` accepts `?wait=<seconds>`
// and holds the response until the workflow reaches a terminal status — or, with
// `?until=change` (which `blocks.pollWorkflow` sends), until the workflow or one of
// its steps changes — replying 202 with the current snapshot if the hold elapses
// first (`GetWorkflowData.query`, `@civitai/orchestration-client`). civitai already uses it on
// four non-blocks paths (`orchestrator.service.ts`, `comics/orchestrator-chat`,
// `product-badge.service`, `training.service`); the blocks poll did not.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The longest hold `blocks.pollWorkflow` will ask the orchestrator for.
 *
 * 🔴 THIS CEILING IS SET BY A CONSTANT IN ANOTHER FILE, NOT BY TASTE.
 * `getWorkflow` (`~/server/services/orchestrator/workflows`) applies
 * `AbortSignal.timeout(ORCHESTRATOR_GET_TIMEOUT_MS)` — 20_000 — UNCONDITIONALLY
 * to every single-workflow read. A hold at or above 20s is therefore killed by
 * our own backstop before the orchestrator can answer, and it fails as a
 * `TimeoutError` mapped to a retry-able 503 — i.e. it would look like an
 * orchestrator outage rather than a misconfigured bound. 15 leaves 5s of slack
 * for connect + the response itself.
 *
 * 🔴 RAISING THIS REQUIRES CHANGING THAT BACKSTOP FIRST, and that backstop is
 * shared with the whole generation status-update path (#2883, added to stop a
 * parked orchestrator read from pinning an api-pool slot). Do not raise it here
 * alone: the result is silently ineffective.
 *
 * The second ceiling, further out: the poll runs an inline output-moderation
 * scan (`screenGeneratedText`, ~12s hard deadline) AFTER this read,
 * sequentially — so the procedure's own worst case is 15 + 12 = 27s. That is
 * the number to check against the edge/proxy response budgets before raising
 * this bound; both were verified to sit well above it at the time of writing.
 */
export const MAX_BLOCK_POLL_WAIT_SECONDS = 15;

/**
 * Concurrent held polls per (install, viewer). The rate bucket alone allows ~300 at once by Little's
 * law; past this cap a poll is answered without a hold, i.e. today's short poll, never refused. 4
 * covers a viewer watching a few generations; a larger batch degrades to short polls.
 */
export const MAX_BLOCK_POLL_CONCURRENT_HOLDS = 4;

/**
 * Normalize a caller-supplied `waitSeconds` into a value safe to hand the
 * orchestrator.
 *
 * 🔴 THE INPUT IS UNTRUSTED — it originates in an app block's iframe, forwarded
 * by the host. It is clamped rather than rejected because a block asking for a
 * hold longer than we allow is not an error, it is a request we satisfy less
 * generously; failing the poll would break a generation over a tuning value.
 *
 * 🔴 THE DEFAULT IS 0 — NO HOLD — AND THAT IS DELIBERATE, NOT AN OVERSIGHT.
 * Enabling long polling for every caller would change the CONCURRENCY profile of
 * every already-deployed block, whose poll loops we do not control and cannot
 * assume are sequential. A block driving `setInterval(poll, 2000)` against a
 * 15s hold stacks ~7 concurrent requests per workflow instead of one — the
 * opposite of the intended effect. So the hold is opt-in per request, and the
 * SDK only sends it from `useBuzzWorkflow().watch()`, whose loop awaits each
 * poll before issuing the next.
 *
 * Returns `undefined` (rather than 0) when there is no hold, so the caller can
 * omit the `query` entirely and keep the request byte-identical to today's.
 */
export function resolveBlockPollWaitSeconds(waitSeconds?: number): number | undefined {
  if (typeof waitSeconds !== 'number' || !Number.isFinite(waitSeconds)) return undefined;
  // Floor before the bounds check: 0.9 must read as "no hold", not as a hold.
  const floored = Math.floor(waitSeconds);
  if (floored <= 0) return undefined;
  return Math.min(floored, MAX_BLOCK_POLL_WAIT_SECONDS);
}

/**
 * The wire schema for `waitSeconds` on `blocks.pollWorkflow` and its REST twin. It never rejects: a
 * missing, `null`, non-number or non-finite value becomes `undefined`, and every finite number is
 * left for `resolveBlockPollWaitSeconds` to floor and cap. A
 * rejected poll reaches the block as a failed generation, which a tuning value must not cause.
 */
export const blockPollWaitSecondsInput = z.number().optional().catch(undefined);
