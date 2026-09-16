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
 * ## 🔴 THREE ENTRIES ARE A JUDGEMENT CALL AND ARE DELIBERATELY REVERSIBLE
 *
 * `ageClassification`, `mediaRating` and `wdTagging` were added by the
 * implementing change, NOT by the operator decision this module implements.
 * The argument is specific to moving moderation to the **publish boundary**: an
 * app that can invoke the platform's own classifiers gets a **moderation
 * oracle** — it can grade candidate content against the very model that will
 * judge it at publish, and iterate until it passes. The type boundary used to
 * deny that for free; the publish boundary does not.
 *
 * If that argument is rejected, these three move to ALLOW and nothing else in
 * this module changes. Say so in the PR rather than editing the set silently.
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
 * `preprocessVideo`, `yuE2`), and the pinned `@civitai/client` did not have
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
 * Frozen: this is on the spend/submit path and is read by a load-time invariant,
 * so post-load mutation would be a way to widen what a block may reach without a
 * code review.
 */
export const PLATFORM_INTERNAL_STEP_TYPES: ReadonlySet<string> = Object.freeze(
  new Set<string>([
    // Scanners — the admissibility pipeline.
    'modelPickleScan',
    'modelClamScan',
    'imageScanning',

    // Moderation classifiers — the models that grade at the publish boundary.
    'xGuardModeration',
    'shieldstralModeration',

    // Hashing / model ingestion — dedup and catalogue identity.
    'mediaHash',
    'modelHash',
    'modelParseMetadata',

    // The orchestrator catalog's own "Platform internals" heading.
    'comfyNodepackSnapshot',
    'qwenImageBench',

    // Web egress.
    'webScrape',
    'webSearch',

    // 🔴 JUDGEMENT CALL — the moderation-oracle argument in this module's
    // docblock. Reversible: if rejected, delete these three and nothing else
    // changes.
    'ageClassification',
    'mediaRating',
    'wdTagging',
  ])
) as ReadonlySet<string>;

/** Stable, sorted view — for error text and tests. Never for membership. */
export const PLATFORM_INTERNAL_STEP_TYPE_LIST: readonly string[] = Object.freeze(
  [...PLATFORM_INTERNAL_STEP_TYPES].sort()
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

/** True when `stepType` is platform-internal and must never be app-submittable. */
export function isPlatformInternalStepType(stepType: string): boolean {
  return PLATFORM_INTERNAL_STEP_TYPES.has(stepType);
}

/**
 * Fail-closed assertion for a single orchestrator `$type`.
 *
 * 🔴 READ THIS BEFORE WIRING A NEW SUBMIT PATH. Today the only way a block
 * reaches the orchestrator is through a REGISTERED step (`REGISTERED_STEP_IDS`,
 * two entries) or the `textToImage` / `customComfy` kinds — none of which lets a
 * block name an arbitrary `$type`. So the live enforcement of this set is the
 * registry invariant in `assertStepInvariants` (no registered entry may declare
 * a denylisted `orchestratorType`), and this function is the reusable predicate
 * behind it.
 *
 * When the wide `kind:'steps'` arm lands — the one that lets a block name a
 * `$type` directly — **it must call this**, and it must call it BEFORE any
 * spend reservation or orchestrator call. A denylist that the wire does not
 * consult is decoration.
 */
export function assertStepTypeAllowed(stepType: string, where?: string): void {
  if (isPlatformInternalStepType(stepType)) {
    throw new PlatformInternalStepTypeError(stepType, where);
  }
}
