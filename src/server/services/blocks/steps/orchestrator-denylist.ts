import { TRAINING_STEP_TYPES } from './output';

/**
 * PLATFORM-INTERNAL ORCHESTRATOR STEP TYPES — the denylist for App Blocks.
 *
 * Context: App Blocks are moving to full orchestrator access with **no per-app
 * allowlist**. Under that direction the bound on what a block may submit stops
 * being "an allowlist of things we said yes to" and becomes "everything except
 * the things that are ours". This module is that exception set.
 *
 * 🔴 THIS IS A `$type` BOUND, NOT A PERMISSION MODEL. It says which orchestrator
 * step types are platform-internal for EVERY app. It says nothing about whether
 * a given app, or a given viewer's consent, permits a submit — that is the
 * `ai:write:budgeted` scope plus the per-viewer grant, and the two are
 * ORTHOGONAL controls. Conflating them is what left the scope-widening question
 * open for six weeks: a denylist bounds which types exist for everyone, and does
 * nothing about an already-approved app silently gaining reach nobody reviewed
 * it for.
 *
 * ## Why each entry is here
 *
 * Three classes, all of them "this is the platform's own machinery":
 *
 *  - **Scanners** (`modelPickleScan`, `modelClamScan`, `imageScanning`) — the
 *    safety pipeline that decides whether an upload is admissible at all.
 *  - **Moderation classifiers** (`xGuardModeration`, `shieldstralModeration`) —
 *    the models that grade content at the publish boundary.
 *  - **Hashing / model ingestion** (`mediaHash`, `modelHash`,
 *    `modelParseMetadata`) — dedup and catalogue identity.
 *
 * Plus the two the orchestrator's own catalog files under a "Platform internals"
 * heading (`comfyNodepackSnapshot`, `qwenImageBench`), and the two web-egress
 * steps (`webScrape`, `webSearch`).
 *
 * ## 🔴 A RETRACTED ADDITION — `ageClassification`, `mediaRating`, `wdTagging`
 *
 * An earlier draft of this module ALSO denied those three, on a
 * "moderation oracle" argument: with moderation moved to the publish boundary,
 * an app that can invoke the platform's own classifiers could grade candidate
 * content against the very model that will judge it, and iterate until it
 * passes. **That argument did not survive audit and the three are ALLOWED.**
 * Recorded rather than deleted, so it is not re-derived:
 *
 *  1. **It buys loop SPEED, not capability denial.** An app holding
 *     `ai:write:budgeted` can publish and observe the platform's own rating
 *     come back on the scanned object. Denying the `$type`s makes a grading
 *     loop slower; it does not make one impossible.
 *  2. **It denied the good-citizen case along with the gaming one.** An app
 *     that wants to REFUSE to publish content its own check flags is exactly
 *     the behaviour we want, and `ageClassification` is the sharp example: the
 *     denial stopped an app checking whether an image depicts a minor BEFORE
 *     touching it. The denial was not neutral.
 *  3. **`wdTagging` is not a moderation grader at all** — it is a WD14-family
 *     tagger with ordinary benign uses (auto-tagging a user's own gallery). It
 *     was in the set by association.
 *
 * Note this is also the reading closer to the operator decision, which named
 * the internal classes as scanners, model ingestion, hashing, web egress and
 * training — not these.
 *
 * ## What is deliberately NOT here
 *
 * `training` and `imageResourceTraining` are **ALLOWED**, by explicit operator
 * decision, and that decision REVERSES an earlier classification that had put
 * training in the platform-internal set. It is called out here because it is
 * the entry a reader is most likely to assume was an oversight: training
 * creates model versions and carries the largest per-call Buzz cost in the
 * catalog. The per-call cap still binds it. `chatCompletion` is likewise
 * allowed and already registered.
 *
 * ## Keeping this honest against a moving catalog
 *
 * 🔴 DO NOT TRUST A COUNT COPIED FROM A DOCUMENT. The live orchestrator spec
 * gained three step types between 2026-08-05 and 2026-09-16 (`imageScanning`,
 * `preprocessVideo`, `yuE2`), and the pinned `@civitai/orchestration-client` did not have
 * them. Re-derive the population when you touch this:
 *
 *   curl -s https://orchestration.civitai.com/openapi/v2-consumers.json \
 *     | jq -r '.components.schemas.WorkflowStepTemplate.discriminator.mapping | keys[]'
 *
 * A step type that is NEW upstream and unknown here is ALLOWED by construction,
 * because this is a denylist. That is the accepted trade of the no-allowlist
 * direction — it is why the set below is limited to things that are
 * unambiguously platform machinery, and why a new scanner or classifier must be
 * added here in the same change that makes the platform depend on it.
 */

/**
 * Orchestrator `$type` values an App Block may never submit.
 *
 * 🔴 AN ARRAY, NOT A `Set`, AND THAT IS THE WHOLE POINT. A previous draft
 * exported `Object.freeze(new Set([...]))` with a comment claiming the freeze
 * stopped post-load mutation widening what a block may reach. **That claim was
 * false and was measured false:** `Set.prototype.add`/`delete` write internal
 * slots rather than properties, so `Object.freeze` is inert against both —
 * `PLATFORM_INTERNAL_STEP_TYPES.delete('xGuardModeration')` succeeded on a
 * frozen Set and the guard silently stopped denying it.
 *
 * `Object.freeze` on an ARRAY genuinely does reject `push`/`splice`/index
 * assignment, so this one is real. The lookup Set below is module-private and
 * never exported, which is what actually makes it unreachable for mutation.
 *
 * (The same trap is documented one container over, on
 * `STEP_TYPE_ACCEPTABLE_POSTURES` in `./index.ts` — that note says a shallow
 * freeze is "a compile-time fiction that a plain `arr.push('none')` walks
 * straight through at runtime", demonstrated by execution. This module repeated
 * the mistake it warns about; now it does not.)
 */
export const PLATFORM_INTERNAL_STEP_TYPES: readonly string[] = Object.freeze([
  // Scanners — the admissibility pipeline.
  'modelPickleScan',
  'modelClamScan',
  'imageScanning',

  // Moderation classifiers — the models that grade at the publish boundary.
  'xGuardModeration',
  'shieldstralModeration',
  'promptModeration',

  // Hashing / model ingestion — dedup and catalogue identity.
  // ⚠️ `mediaHash` is denied here while `./index.ts` records it as "considered
  // and NOT registered … adding it later is one file plus one line here". Both
  // cannot be true; this denial is the newer decision and that note now says so.
  'mediaHash',
  'modelHash',
  'modelParseMetadata',

  // The orchestrator catalog's own "Platform internals" heading.
  'comfyNodepackSnapshot',
  'qwenImageBench',

  // Web egress.
  'webScrape',
  'webSearch',

  // RETIRED, not a platform internal — the odd one out in this list. The app
  // emits no `textToImage` step any more (every image family names its engine
  // via a specialised `imageGen` endpoint), so the only way one could still be
  // created is a block naming it on the pass-through arm. Denying it is what
  // makes "zero created after the cutover" a property rather than a hope.
  // A block that WAS using it breaks loudly here, which is the intended failure.
  // Nothing on the `kind: 'textToImage'` BODY path reaches this guard — that is
  // an API verb meaning "generate an image", resolved through the generation
  // graph, and it stays.
  'textToImage',
]);

/**
 * Module-private membership index. Never exported — that is what makes the set
 * genuinely unmutatable from outside, where the retracted `Object.freeze(Set)`
 * only looked as though it did.
 */
const PLATFORM_INTERNAL_LOOKUP = new Set<string>(
  PLATFORM_INTERNAL_STEP_TYPES.map(foldStepTypeCase)
);

/**
 * Thrown when a block reaches for a platform-internal `$type`.
 *
 * 🔴 ITS OWN ERROR CLASS ON PURPOSE. A denylist refusal must be distinguishable
 * from a generic schema/validation rejection — otherwise a test asserting "the
 * denylist refused it" is really asserting "something refused it", which stays
 * green after the denylist is deleted. Every guard in this module throws THIS,
 * and the tests assert THIS, so a mutation that removes the guard cannot die to
 * a neighbouring check's error.
 */
export class PlatformInternalStepTypeError extends Error {
  readonly stepType: string;

  constructor(stepType: string, where?: string) {
    super(
      `${where ? `${where}: ` : ''}orchestrator step type '${stepType}' is platform-internal ` +
        'and cannot be submitted by an app block'
    );
    this.name = 'PlatformInternalStepTypeError';
    this.stepType = stepType;
  }
}

/**
 * True when `stepType` is platform-internal and must never be app-submittable.
 *
 * 🔴 CASE-FOLDED, and that is load-bearing rather than tidy. On the pass-through
 * `kind:'step'` arm this denylist is the ONLY control, and the value it sees is
 * a caller-supplied string forwarded verbatim to an orchestrator this repo does
 * not own. An exact `Set.has()` therefore let `'XGuardModeration'` through — a
 * complete bypass of the control if that orchestrator happens to match `$type`
 * case-insensitively, which is not knowable from here and not ours to assume in
 * either direction. Folding case makes the guard hold for BOTH answers.
 *
 * It denies a strict SUPERSET of what it denied before, and that widening is
 * safe by measurement rather than by hope: all 50 `$type` keys in the live
 * `WorkflowStepTemplate.discriminator.mapping` are distinct when lowercased
 * (measured 2026-09-17 — 50 keys, 50 distinct-lowercased), so folding cannot
 * make an ALLOWED type collide with a denied one. Re-measure that before adding
 * an entry whose lowercasing could collide with a legitimate type.
 */
export function isPlatformInternalStepType(stepType: string): boolean {
  return PLATFORM_INTERNAL_LOOKUP.has(foldStepTypeCase(stepType));
}

/**
 * THE one case fold for comparing a caller-supplied `$type` against a server-owned
 * list. The comparisons that use it: `isPlatformInternalStepType` (the denylist) and
 * `isTrainingStepTypeIgnoringCase` (every training check on a caller-supplied `$type`,
 * listed there), so two lists cannot disagree about what "the same step type" means.
 */
export function foldStepTypeCase(stepType: string): string {
  return stepType.toLowerCase();
}

const TRAINING_STEP_TYPE_LOOKUP: ReadonlySet<string> = new Set(
  TRAINING_STEP_TYPES.map(foldStepTypeCase)
);

/**
 * True when a CALLER-SUPPLIED `$type` names a training step type, matched
 * case-insensitively — consistent with `isPlatformInternalStepType`, and for the same
 * reason: how the orchestrator matches `$type` case is not knowable from here, so a
 * refusal keyed on this must hold for either answer.
 *
 * 🔴 EVERY TRAINING CHECK ON A CALLER-SUPPLIED `$type` USES THIS. The sites, all in
 * `blocks.router`:
 *   - `assertNotTrainingStepType` — a training type is never a confirmed step;
 *   - `refuseUnquotedTraining` — an unquoted training step is refused;
 *   - `buildPassThroughWorkflowTags` — a training step carries `TRAINING_WORKFLOW_TAG`;
 *   - `buildMultiStepWorkflowTags` / `multiStepTrainingType` — the same two rules for
 *     every step of a `kind:'workflow'` body.
 *
 * `isTrainingStepType` (exact) is kept ONLY where the `$type` was read off a workflow
 * the orchestrator RETURNED, and as the type guard narrowing to `TrainingStepType`:
 *   - `splitPassThroughStep` (`steps/output.ts`) — splitting a returned step's output;
 *   - `hasBlockTrainingStep` / `projectAppWorkflow` (`workflow.service.ts`) — reading a
 *     returned training step.
 */
export function isTrainingStepTypeIgnoringCase(stepType: string): boolean {
  return TRAINING_STEP_TYPE_LOOKUP.has(foldStepTypeCase(stepType));
}

/**
 * Fail-closed assertion for a single orchestrator `$type`.
 *
 * 🔴 READ THIS BEFORE WIRING A NEW SUBMIT PATH. This set now has THREE
 * enforcement sites, and they are different in kind:
 *
 *   - the registry invariant in `assertStepInvariants` — no registered entry may
 *     declare a denylisted `orchestratorType`, checked at LOAD;
 *   - `assertPassThroughStepTypeAllowed` in `blocks.router` — the PASS-THROUGH
 *     arm (`kind:'step'` with a bare `$type`, note the SINGULAR `step`; an
 *     earlier draft of this paragraph called it `kind:'steps'` and the plural
 *     greps to nothing), which lets a block name a `$type` directly, so
 *     this set is the only bound there. It runs on both the
 *     estimate and the submit, BEFORE any orchestrator call and before any spend
 *     reservation. A denylist that the wire does not consult is decoration.
 *   - `prepareMultiStepWorkflow` in `blocks.router` — the `kind:'workflow'` arm,
 *     which runs it on EVERY step at the same point on both paths.
 *
 * Both router sites also check the step a `repeat` runs
 * (`collectBlockStepTypes`).
 *
 * The match is case-folded (see `isPlatformInternalStepType`), so a re-cased
 * `$type` is refused on both router arms too.
 */
export function assertStepTypeAllowed(stepType: string, where?: string): void {
  if (isPlatformInternalStepType(stepType)) {
    throw new PlatformInternalStepTypeError(stepType, where);
  }
}
