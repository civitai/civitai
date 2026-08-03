import type * as z from 'zod';
import { convertImageStep } from './convert-image.step';
import type { StepOutputMedia } from './output';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks STEP-TYPE registry (`kind: 'step'`) — RFC #3515 migration step 1.
//
// WHAT THIS IS. A generalization of the `customComfy` recipe registry
// (`~/server/services/blocks/recipes`) from "Comfy recipes" to "orchestrator
// step types". A registered step bundles a stable id, a bounded `.strict()`
// param schema, a pure builder onto an orchestrator step template, a DECLARED
// BILLING MODE, and a DECLARED MODERATION POSTURE.
//
// The block schema's `step` enum is DERIVED from this registry's keys
// (`REGISTERED_STEP_IDS`), so an unregistered id fails closed at the WIRE
// schema — before any translator, any spend reservation, or any orchestrator
// call. Adding a capability is one small reviewed civitai PR: write a
// `<name>.step.ts`, register it below, add tests. The `kind` (`step`) and the
// router are untouched.
//
// 🔴 THE REGISTRY IS A CODE-REVIEWED, NON-DB-EDITABLE TRUST ROOT. Exactly the
// posture the recipe registry has, and it must not change. This module has no
// DB access and loads at import time, before any request context.
//
// 🔴 THIS IS ON THE SPEND PATH. A change here changes what a block can spend.
// Treat every edit as a spend-safety review, not a content edit.
//
// WHAT THIS IS NOT (deliberately, per the RFC):
//   - It does NOT absorb `kind: 'textToImage'`. That member carries entitlement
//     gating over the checkpoint AND the LoRA stack, availability gates,
//     model-token binding, the page-only `sourceImage` rule, `accountType`
//     currency ordering, `sharedContentKey` attribution, and POI handling.
//     Two kinds — a rich first-class generation path plus a uniform registry
//     for everything else — is the honest split.
//   - It does NOT absorb `kind: 'customComfy'`. Migrating that member behind
//     this registry (with `kind: 'customComfy'` retained as a deprecated alias)
//     is the RFC's migration step 3 and is deliberately OUT OF SCOPE here.
//     Step 1 is "land the registry alongside the existing members; nothing
//     breaks."
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Billing mode — "the one field the current interface is missing" (RFC).
//
// `BlockRecipe.budgetFor` encodes `maxBuzz === ceil(stepTimeoutSeconds × 1)`,
// which is elegant *because* it is time-bounded: the aggressive step timeout is
// the physical cap at ~1 Buzz/GPU-second. That invariant does not generalize to
// every step type, so the mode is declared per entry and the money path
// DISPATCHES ON IT.
//
// 🔴 ALL THREE VALUES ARE DEFINED NOW even though the registry only uses
// `prepaidFixed` today. That is the point: the wire contract and the type
// surface are the expensive things to change once `@civitai/app-sdk` mirrors
// them, so future step types must be ADDITIVE (register an entry) rather than a
// schema change. A mode with no registered entry has no money-path handler yet
// and FAILS AT REGISTRY LOAD (see `assertStepInvariants`) — it can never
// silently ride another mode's reservation logic.
// ─────────────────────────────────────────────────────────────────────────────
export type StepBillingMode =
  /** GPU work with variable duration; the step timeout is the physical cap. */
  | 'timeBounded'
  /** Deterministic cost, exactly knowable before execution. */
  | 'prepaidFixed'
  /** Cost scales with tokens, not wall-clock. */
  | 'tokenMetered';

export const STEP_BILLING_MODES: readonly StepBillingMode[] = [
  'timeBounded',
  'prepaidFixed',
  'tokenMetered',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Moderation posture — REQUIRED, and required for a reason.
//
// `BlockRecipe.negativePrompt` exists so the prompt-audit re-point has
// something to read. That hook does not generalize: a step with no prompt
// (image conversion) has no such surface, and a step with a TEXT OUTPUT
// (`chatCompletion`, `mediaCaptioning`, `audioCaptioning`, `transcription`) has
// a NEW one that the prompt audit does not cover at all.
//
// 🔴 MAKING THIS FIELD REQUIRED IS THE WHOLE MECHANISM. Registering a
// text-producing step later is impossible without someone explicitly answering
// the policy question in code — it cannot be quietly skipped, because a posture
// with no implemented handler fails at registry LOAD (a build-time error), not
// at request time on a Friday.
//
// 🔴 THE FREE-TEXT-INPUT HALF OF THAT QUESTION IS NOW ANSWERED (#3527): mature
// content is permitted for App Blocks, bounded by the token's server-minted
// maturity ceiling — so a free-text INPUT needs the same prompt audit
// `textToImage` / `customComfy` already run, not a new policy. `'promptAudit'`
// is therefore IMPLEMENTED; its handler lives in `./moderation` and runs
// `auditPromptServer` host-side, before the orchestrator submit. The free-text
// OUTPUT half (`'textOutput'`) is still unanswered and still fails at load.
// ─────────────────────────────────────────────────────────────────────────────
export type StepModerationPosture =
  /**
   * No free-text input and no free-text output — the step introduces no new
   * moderation surface, so there is nothing to run.
   */
  | 'none'
  /**
   * Free-text INPUT that goes through the existing server prompt audit
   * (`auditPromptServer`), as `textToImage` / `customComfy` do.
   *
   * IMPLEMENTED. An entry declaring it MUST also declare `auditableText` (see
   * that field) — a posture that can be satisfied by auditing nothing is not a
   * posture, so both the declaration and its non-emptiness are enforced at
   * registry LOAD, and again per-request in the handler.
   */
  | 'promptAudit'
  /**
   * Free-text OUTPUT — a moderation surface the prompt audit does not cover.
   * Generated text is scanned by NOTHING on any current path.
   * NOT IMPLEMENTED — registering an entry with this posture fails at load.
   */
  | 'textOutput';

export const STEP_MODERATION_POSTURES: readonly StepModerationPosture[] = [
  'none',
  'promptAudit',
  'textOutput',
] as const;

/**
 * The free text a `'promptAudit'` entry hands to `auditPromptServer`.
 *
 * Deliberately the EXACT two fields `textToImage` and `customComfy` already
 * pass, so the posture runs the same audit with the same inputs rather than a
 * parallel one. An entry with several user-text params joins them into `prompt`
 * itself — explicitly, in its own file, where a reviewer can see which params
 * are covered — rather than the registry guessing from field names.
 */
export type StepAuditableText = {
  /** The user-authored text. MUST be non-empty (enforced at load AND per request). */
  prompt: string;
  /** Optional second field, matching `auditPromptServer`'s own signature. */
  negativePrompt?: string;
};

/**
 * True iff the posture's handler needs the entry to declare `auditableText`.
 *
 * 🔴 The one place that relationship is written down. The load-time invariant,
 * the request-time handler and the tests all read THIS — a second copy is how
 * the guard and the thing it guards drift apart.
 */
export function postureRequiresAuditableText(posture: StepModerationPosture): boolean {
  return posture === 'promptAudit';
}

/**
 * The orchestrator step template a step builder emits: the `$type` discriminator
 * plus its bounded `input`. The envelope concerns the router owns (`name`, and
 * the `timeout` a `timeBounded` entry would stamp) are added at submit — keep
 * builders free of them, exactly as `CustomComfyStepInput` is kept free of the
 * customComfy step envelope.
 */
export type OrchestratorStepTemplate = {
  $type: string;
  input: Record<string, unknown>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Resource / entitlement posture — REQUIRED, for the same reason
// `moderationPosture` is.
//
// 🔴 `BlockRecipe` — the interface this registry generalizes — carries
// `resourceAllowlist` AND `checkpointPolicy`. Neither survived the first draft
// of the generalization, and that omission was the sharper half of the pair:
// entitlement is the axis this PR's OWN Tranche-1 triage named as the real
// risk. `imageUpscaler` was disqualified PRECISELY because its `model` field
// takes an arbitrary AIR URN, which would let an untrusted iframe reach the
// orchestrator around the generation-graph entitlement belt. With no declared
// field, a future entry with exactly that shape would register cleanly and
// every other load-time invariant would pass — the registry would look guarded
// on the axis it is least guarded on.
//
// 🔴 Only `'none'` has an implemented handler. A step that reaches ANY AIR
// resource needs a real, reviewed allowlist implementation (checkpoint policy
// included — a checkpoint IS an AIR, so it is a `staticAllowlist` case, not a
// separate field), and until one exists it fails at registry LOAD. Same
// unskippable property moderation already had.
// ─────────────────────────────────────────────────────────────────────────────
export type StepResourcePolicy =
  /**
   * The step references NO AIR resource of any kind — there is nothing for the
   * entitlement belt to gate and no way to reach a gated / early-access /
   * Private model version through it. The ONLY policy with an implemented
   * handler today, and it is ENFORCED, not merely declared: the built step is
   * probed at load and must contain no AIR reference (see `assertStepInvariants`).
   */
  | { kind: 'none' }
  /**
   * A fixed, code-reviewed set of AIRs the step may reach — the generalization
   * of `BlockRecipe.resourceAllowlist` + `checkpointPolicy`.
   * NOT IMPLEMENTED — registering an entry with this policy fails at load.
   */
  | { kind: 'staticAllowlist'; airs: readonly string[] };

/** True iff the resource policy has an implemented handler. */
export function isResourcePolicyImplemented(policy: StepResourcePolicy): boolean {
  return policy.kind === 'none';
}

/** The AIR URN scheme prefix. Lowercase; the scan lowercases its input. */
const AIR_URN_PREFIX = 'urn:air:';

/**
 * True when any string ANYWHERE in the value is (or embeds) an AIR URN.
 *
 * Deliberately a deep scan rather than a check of a known field name: the point
 * is to catch an AIR arriving through a field NOBODY thought to look at, which
 * is the only way the `'none'` declaration can become a lie.
 */
export function containsAirReference(value: unknown): boolean {
  if (typeof value === 'string') return value.toLowerCase().includes(AIR_URN_PREFIX);
  if (Array.isArray(value)) return value.some(containsAirReference);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsAirReference);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT EXTRACTION — registering a step and surfacing its result are ONE
// action.
//
// 🔴 WHY THIS IS A REGISTRY FIELD AND NOT A BRANCH IN `workflow.service`.
// `snapshotFromWorkflow` (the poll/submit snapshot) and `projectAppWorkflow`
// (the `queryAppWorkflows` subqueue read) each carried a hardcoded `$type`
// allowlist — `customComfy | textToImage | imageGen | comfy` — and `continue`d
// on everything else. `convertImage`'s output is `{ blob?: ImageBlob }`
// (SINGULAR `blob`, not `images` and not `blobs`), so BOTH extractors were
// blind to it in two independent ways: the `$type` and the key. The result was
// a capability that charges Buzz, reaches `succeeded`, and can never return its
// result to the caller — inert, but only after the money moved.
//
// A fourth hardcoded `if ($type === 'convertImage')` branch would have fixed
// today and guaranteed the next registered step repeated it; the same class had
// already recurred twice elsewhere. So the entry DECLARES its own extraction,
// the two extractors consult the registry by `$type`, and a new entry that gets
// it wrong is a LOAD-TIME failure (clause 8) rather than a silent inert
// capability.
// ─────────────────────────────────────────────────────────────────────────────

// The extraction primitives live in the leaf module `./output` (see its header
// for why). Re-exported here so `~/server/services/blocks/steps` stays the one
// import site for consumers that aren't registry entries.
export type { StepOutputMedia } from './output';
export { mediaFromBlobs } from './output';

/**
 * The `$type` values `workflow.service`'s two extractors handle NATIVELY, with
 * their own long-standing inline branches.
 *
 * 🔴 A registered step MUST NOT claim one of these (enforced, clause 9). That
 * invariant is what makes the registry branch safe to place BEFORE the native
 * `$type` filter: it cannot shadow an existing branch, so `textToImage` /
 * `imageGen` / `comfy` / `customComfy` extraction stays byte-identical.
 */
export const NATIVELY_EXTRACTED_STEP_TYPES: readonly string[] = [
  'customComfy',
  'textToImage',
  'imageGen',
  'comfy',
] as const;

/**
 * ORCHESTRATOR `$type` → the moderation postures ACCEPTABLE for that type.
 *
 * 🔴 WHY THIS EXISTS. `moderationPosture` is SELF-DECLARED by the entry, and
 * every other clause only checks the declaration against ITSELF: clause 1 asks
 * "does the declared posture have a handler", clauses 1a/5a ask "does the
 * declared posture's own field exist and return something". Nothing asked
 * whether the declaration MATCHES WHAT THE STEP ACTUALLY DOES. So a
 * `chatCompletion` entry declaring `'promptAudit'` — auditing its input,
 * emitting unscanned free text — registered cleanly and passed every check.
 * The gate whose entire purpose is "a text-producing step cannot register until
 * someone answers the policy question" was satisfiable by answering a DIFFERENT
 * question.
 *
 * This is the same defect class as `auditableText` returning `''` (clause 5a)
 * and `extractOutput` returning `[]` (clause 8), one level up: there the field
 * was satisfiable by a no-op, here the FIELD ITSELF was satisfiable by naming
 * the wrong axis.
 *
 * 🔴 THIS MAP IS ONLY HALF THE CONTROL. It is keyed on `orchestratorType`,
 * which the entry author also writes, so on its own it checks one declaration
 * against another. CLAUSE 7a — `buildStep(...).$type === orchestratorType` —
 * is what ties that key to the type actually submitted. Weaken 7a and this map
 * becomes advisory.
 *
 * 🔴 A SET, NOT A LADDER, AND DELIBERATELY SO. Modelling postures as a
 * strength ordering (`none` < `promptAudit` < `textOutput`) would bake in a
 * claim nobody has made — that `'textOutput'`, once implemented, also audits
 * input. It might; that is a design decision for whoever implements it, and
 * encoding it here as an ordering would hide it. Membership states only what is
 * acceptable, per type, with no transitive claim.
 *
 * 🔴 RESIDUAL GAP, STATED RATHER THAN PAPERED OVER. This constrains the types
 * LISTED. A text-producing `$type` nobody listed is unconstrained, exactly as
 * before. The alternative — inferring text-production from the output shape —
 * is the sniffing this file already rejects for `auditableText` ("sniffing for
 * string-valued fields would audit a Civitai image URL"), and it would be
 * *more* fragile here because it would run against a sample the entry author
 * also wrote. The mitigation is that adding an entry is a reviewed PR and this
 * map is the place review looks.
 *
 * 🔴 THE FREE-TEXT-*INPUT* AXIS IS DELIBERATELY OUT OF SCOPE, and saying so is
 * the point. An earlier revision listed `textToSpeech` (free text in, audio
 * out) with `['promptAudit', 'textOutput']`. That was wrong twice: the second
 * value was exactly the subsumption claim the SET-NOT-A-LADDER note above
 * disclaims, and the criterion was half-applied — if text-IN qualifies, so do
 * `aceStepAudio` (`lyrics`), `imageGen`, `videoGen`, `polyGen`, `wdTagging`
 * and roughly a dozen more, none of which were listed. A partially-applied
 * rule gives false comfort, so the rule here is the narrow, complete one:
 * free-text OUTPUT. An unlisted text-IN type registering as `'none'` skips an
 * audit it should run — a real gap, RECORDED AND NOT CLOSED, and a different
 * shape of problem because `'promptAudit'` is implemented and so that entry
 * would at least be registrable once someone notices.
 *
 * Enumerated from the generated `@civitai/client` `$type` literals, not from
 * `src/**` usage — the same correction the registry's Tranche 1 note records:
 * grepping usage enumerates what is CALLED, not what EXISTS.
 */
/**
 * 🔴 `satisfies`, NOT a cast, and that distinction is load-bearing. The literal
 * has to be CONTEXTUALLY TYPED for a mistyped posture (`'textOputput'`) to be a
 * compile error. Writing it as `Object.create(null) as Record<…>` — the obvious
 * way to get the null prototype below — removes that context and a typo
 * compiles clean, which was measured, not assumed. Declaring the literal here
 * with `satisfies` keeps the check; `Object.assign` then carries it onto a
 * null-prototype target without widening it back.
 */
const ACCEPTABLE_POSTURES_BY_TYPE = {
  // 🔴 THE INCLUSION CRITERION, and it is exactly one thing: this type's OUTPUT
  // carries free text. The prompt audit does not cover generated text at all,
  // so `'promptAudit'` is never an acceptable answer here — declaring it would
  // audit the input and ship the output unscanned. Every entry is therefore a
  // single value, which is what keeps this map free of any claim that one
  // posture subsumes another (see the SET-NOT-A-LADDER note above).
  chatCompletion: ['textOutput'],
  mediaCaptioning: ['textOutput'],
  audioCaptioning: ['textOutput'],
  transcription: ['textOutput'],
  // An LLM prompt rewriter: free text in AND out (`enhancedPrompt`,
  // `recommendations[]`, `issues[].description` on its output type).
  promptEnhancement: ['textOutput'],
  // Returns `modelReason` — a free-text rationale — alongside its verdict.
  xGuardModeration: ['textOutput'],
  // Echoes caller-supplied `message` back out.
  echo: ['textOutput'],
} satisfies Record<string, readonly StepModerationPosture[]>;

/**
 * 🔴 THE ARRAYS ARE FROZEN TOO, AND THAT IS NOT BELT-AND-BRACES.
 * `Object.freeze` is SHALLOW: freezing only the outer object leaves every
 * posture array mutable, and `readonly` is a compile-time fiction that a plain
 * `arr.push('none')` walks straight through at runtime — after which a
 * `chatCompletion` entry declaring `'none'` registers cleanly. That was
 * demonstrated by execution in review, not hypothesised. This module loads
 * before any request context, so the window is small, but "small window on a
 * spend-path trust root" is not a reason to leave a mutable allowlist.
 */
export const STEP_TYPE_ACCEPTABLE_POSTURES: Readonly<
  Record<string, readonly StepModerationPosture[]>
> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, readonly StepModerationPosture[]>,
    Object.fromEntries(
      Object.entries(ACCEPTABLE_POSTURES_BY_TYPE).map(([type, postures]) => [
        type,
        Object.freeze([...postures]),
      ])
    ) as Record<string, readonly StepModerationPosture[]>
  )
);

/**
 * The postures acceptable for an orchestrator `$type`, or `undefined` when the
 * type carries no declared constraint (every posture is acceptable, which is
 * the pre-existing behaviour).
 */
export function acceptablePosturesFor(
  orchestratorType: string
): readonly StepModerationPosture[] | undefined {
  // 🔴 THE NULL PROTOTYPE ON THE MAP IS WHAT MAKES THIS BARE INDEX SAFE, and it
  // is a control rather than a style choice — the same one `./moderation`
  // documents on its handler table. A plain object literal inherits from
  // `Object.prototype`, so an entry declaring `orchestratorType: 'toString'`
  // would index to `Object.prototype.toString` — TRUTHY — and the clause below
  // would then call `.includes` on a FUNCTION and throw a raw TypeError out of
  // registry load, or under any other comparison read as a satisfied
  // constraint. With a null prototype every non-own key reads `undefined` and
  // the type is treated as unconstrained, which is the pre-existing behaviour.
  return STEP_TYPE_ACCEPTABLE_POSTURES[orchestratorType];
}

/**
 * Fields every registered step declares, regardless of billing mode.
 *
 * `P` is the step's bounded param type (inferred from `paramSchema`).
 */
interface BlockStepBase<P> {
  /** Stable id. The wire `step` enum is DERIVED from the registry keys. */
  id: string;
  /** The orchestrator `$type` this step submits as. */
  orchestratorType: string;
  /** 🔴 REQUIRED. Drives estimate/submit/settle dispatch. */
  billingMode: StepBillingMode;
  /** 🔴 REQUIRED. See `StepModerationPosture`. */
  moderationPosture: StepModerationPosture;
  /**
   * 🔴 REQUIRED IFF `moderationPosture` requires it (`'promptAudit'`), and
   * FORBIDDEN otherwise. PURE: bounded params → the free text to audit.
   *
   * WHY THIS IS A DECLARED FIELD AND NOT AN INFERENCE. A step's params are
   * arbitrary per entry — there is no universal `prompt` key, and sniffing for
   * string-valued fields would audit a Civitai image URL while missing
   * `messages[].content`. So the entry NAMES its user text, exactly as
   * `canonicalOutputFor` makes the output shape explicit rather than inferred.
   *
   * 🔴 AND IT CANNOT BE SATISFIED BY RETURNING NOTHING. `auditPromptServer`
   * RETURNS EARLY on an empty prompt, so `() => ({ prompt: '' })` would be a
   * declared posture that audits nothing and reports success — the same defect
   * class as an `extractOutput` satisfiable by `() => []`, which is why that
   * field got a probe. This one gets the same treatment: the load-time invariant
   * evaluates it against `canonicalParamsFor(variant)` and REJECTS an empty
   * result, and the request-time handler rejects an empty result again on the
   * params actually submitted.
   *
   * HONEST LIMIT, stated so nobody over-trusts it: this proves the entry audits
   * SOMETHING, not that it audits EVERYTHING. Nothing structural can know which
   * of an arbitrary param object's strings are user-authored. The load-bearing
   * guard for coverage is the same one `resourcePolicy` relies on — a required,
   * reviewed declaration in a code-reviewed trust root.
   */
  auditableText?(params: P): StepAuditableText;
  /**
   * 🔴 REQUIRED. See `StepResourcePolicy`. The entitlement axis — the one this
   * PR's own triage identified as the real bypass risk, and the one a
   * generalization of `BlockRecipe` must not drop.
   */
  resourcePolicy: StepResourcePolicy;
  /**
   * Bounded param schema. MUST be `.strict()` — an unknown param is REJECTED,
   * never silently dropped. Enforced behaviourally at registry load.
   *
   * 🔴 This is not a style preference. `blockTextToImageBodySchema` is NOT
   * `.strict()`, and that non-strictness is exactly what let an older host
   * silently strip `sourceImages` and bill the wrong generation. A dropped
   * param on a money path is a wrong-generation bug, not a validation nit.
   */
  paramSchema: z.ZodType<P>;
  /**
   * The variants this step exposes — the generalization of `BlockRecipe.engines`
   * ("which variant did this resolve to?", an open question in the RFC). Every
   * billing mode keys its price/budget off a variant, which is what lets the
   * load-time invariant loop enumerate the population WITHOUT constructing full
   * params (the same reason `budgetForEngine` exists on `BlockRecipe`).
   */
  variants: readonly string[];
  /**
   * The SINGLE source of truth for "which variant did this submit resolve to?".
   * The price/budget, the built step, and the display estimate MUST all agree on
   * this one value, so they all derive it here. Returns a bounded id from
   * `variants` — never a client-raw string.
   */
  resolveVariant(params: P): string;
  /**
   * A canonical, schema-valid params object for the given variant.
   *
   * Exists SOLELY for the load-time invariant loop, which must evaluate
   * `estimateBuzz` and the strictness probe — both of which need real params —
   * without a request context. Without it the `prepaidFixed` invariant would
   * degrade to "the declared price is an integer", which cannot catch the
   * failure that actually costs money: an `estimateBuzz` that disagrees with
   * the price the caller is charged.
   */
  canonicalParamsFor(variant: string): P;
  /** PURE builder: bounded params → the orchestrator step template. */
  buildStep(params: P): OrchestratorStepTemplate;
  /** The Buzz figure `estimateWorkflow` shows the block. */
  estimateBuzz(params: P): number;
  /**
   * 🔴 REQUIRED. PURE extractor: the orchestrator's completed step object → the
   * output media the caller gets back. Called by BOTH `snapshotFromWorkflow`
   * (`imageUrls`) and `projectAppWorkflow` (`images`), so one declaration
   * surfaces the result on both read surfaces.
   *
   * MUST apply the availability filter — use the shared `mediaFromBlobs` helper
   * rather than reimplementing it.
   *
   * Takes the whole step (not `step.output`) because the output KEY is
   * step-type-specific: `convertImage` returns `{ blob }`, `customComfy`
   * returns `{ blobs }`, the image steps return `{ images }`. Typed `unknown`
   * because the orchestrator step union is wider than any one entry knows;
   * narrow it inside the entry.
   */
  extractOutput(step: unknown): StepOutputMedia[];
  /**
   * A canonical, orchestrator-SHAPED completed step object for the given
   * variant, carrying at least one available output blob.
   *
   * Exists SOLELY for the load-time extraction probe (clause 8), the same way
   * `canonicalParamsFor` exists for the budget/strictness probes. Without it,
   * `extractOutput` would be a required field that a new entry could satisfy
   * with `() => []` — compiling, registering, and shipping the exact inert
   * capability this field exists to prevent.
   *
   * 🔴 Populate it from a REAL observed orchestrator response, not from what the
   * extractor expects. A sample written to match the code proves only that the
   * code matches itself.
   */
  canonicalOutputFor(variant: string): unknown;
}

/**
 * Deterministic cost, exactly knowable before execution.
 *
 * 🔴 `prepaidFixed` HAS ITS OWN ENFORCED LOAD-TIME INVARIANT — it is NOT
 * exempted from the registry's structural guard. The `timeBounded` invariant
 * (`maxBuzz === ceil(stepTimeoutSeconds)`) rests on a step timeout being a
 * PHYSICAL cap at ~1 Buzz/GPU-second; a fixed-price step has no such time
 * relationship and cannot satisfy it. If `prepaidFixed` entries merely SKIPPED
 * the check, the guard would still exist but would no longer be reachable for
 * the new class — structurally the worst outcome, because the registry would
 * look guarded while new entries were unguarded. So this mode declares an
 * equivalent invariant, validated at load with the same fail-fast shape:
 *
 *   for every variant v:
 *     priceForVariant(v) is a positive safe integer
 *     estimateBuzz(canonicalParamsFor(v)) === priceForVariant(v)
 *
 * The second clause is the money-relevant one: the price is what gets RESERVED
 * against every cap, and `estimateBuzz` is what the app is SHOWN. A divergence
 * means the block quotes one number and the viewer is charged another.
 */
interface PrepaidFixedStep<P> extends BlockStepBase<P> {
  billingMode: 'prepaidFixed';
  /** The exact Buzz price. Positive integer, constant per variant. */
  priceForVariant(variant: string): number;
}

/**
 * GPU work with variable duration. Carries the `BlockRecipe` invariant verbatim
 * (`maxBuzz === ceil(stepTimeoutSeconds)`) because it rests on the same physics.
 *
 * Declared now so the type surface is stable; NO entry uses it yet, and its
 * money-path handler is not implemented, so registering one fails at load.
 */
interface TimeBoundedStep<P> extends BlockStepBase<P> {
  billingMode: 'timeBounded';
  budgetForVariant(variant: string): { maxBuzz: number; stepTimeoutSeconds: number };
}

/**
 * Cost scales with tokens, not wall-clock — the mode that genuinely does not
 * fit today's model, and the reason to sequence LLM steps last (RFC).
 *
 * Declared now so the type surface is stable; NO entry uses it yet, and its
 * money-path handler is not implemented, so registering one fails at load.
 */
interface TokenMeteredStep<P> extends BlockStepBase<P> {
  billingMode: 'tokenMetered';
  maxBuzzForVariant(variant: string): number;
}

/**
 * A registered step. A DISCRIMINATED UNION on `billingMode`, which is what makes
 * a missing or unknown `billingMode` a COMPILE error rather than a runtime
 * surprise (no union member matches), and what gives each mode its own required
 * price/budget accessor.
 */
export type BlockStep<P = unknown> = PrepaidFixedStep<P> | TimeBoundedStep<P> | TokenMeteredStep<P>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyBlockStep = BlockStep<any>;

// ─────────────────────────────────────────────────────────────────────────────
// Spend planning — the money-path dispatch.
//
// 🔴 estimate / submit / settle dispatch on `billingMode`, NEVER on `kind` and
// never on the step id. The router calls `planStepSpend` / `estimateStepBuzz`
// and reads the returned plan; it contains no per-step and no per-mode branch.
// Adding a capability is register-an-entry; adding a MODE is add-a-handler
// here — neither is router surgery. That is the whole point of the RFC.
// ─────────────────────────────────────────────────────────────────────────────

export type StepSpendPlan = {
  /**
   * The Buzz reserved against EVERY cap (per-user daily, per-app aggregate,
   * dev-session) BEFORE the orchestrator submit, and gated against the token's
   * per-call `buzzBudget`.
   */
  reserveBuzz: number;
  /**
   * True when `reserveBuzz` is a CEILING that a terminal poll/cancel must settle
   * down to the real accrued cost (the post-paid machinery `customComfy` uses).
   *
   * `prepaidFixed` is FALSE: the price is exact and known before execution, so
   * the reservation is final and the post-paid settle machinery is never
   * touched — no settle record is persisted and no terminal refund is owed.
   */
  postPaidSettle: boolean;
  /**
   * True when a REALIZED cost above `reserveBuzz` must be topped up onto the cap
   * counters immediately, at submit.
   *
   * 🔴 THIS IS `prepaidFixed`-SHAPED AND MUST NOT RUN FOR EVERY MODE. It is
   * correct only when the reservation is an EXACT price: the counters are then
   * genuinely short by the difference and nothing else will ever fix them. For a
   * mode whose reservation is a CEILING (`timeBounded`), a submit-time cost
   * above the ceiling would be topped up here AND then settled ceiling→actual by
   * the post-paid machinery off the UN-topped-up ceiling — double-counting the
   * overage and then unwinding the wrong number. The correction used to fire
   * unconditionally on `overage > 0`, which is a latent version of exactly that,
   * and it defeats the additivity this registry exists to guarantee. So the mode
   * decides, here, and the router stays mode-agnostic.
   *
   * Mutually exclusive with `postPaidSettle` by construction.
   */
  correctReservationOverage: boolean;
  /**
   * The orchestrator step `timeout` to stamp, for modes whose cap IS a timeout.
   * `null` when the mode does not use one (`prepaidFixed`: the price is not a
   * function of wall-clock, so a timeout would be a liveness knob, not a Buzz
   * ceiling, and stamping one here would imply a cap relationship that does not
   * exist).
   */
  stepTimeoutSeconds: number | null;
};

type BillingModeHandler = {
  estimateBuzz(step: AnyBlockStep, params: unknown): number;
  planSpend(step: AnyBlockStep, params: unknown): StepSpendPlan;
};

/**
 * A mode that is DECLARED (so the type + wire surface is stable and future
 * additions are additive) but whose money path is not implemented yet.
 *
 * This is a fail-closed gate, not a placeholder: registering an entry with such
 * a mode is rejected at registry LOAD by `assertStepInvariants`, so these
 * functions are unreachable for any registered step. They exist so that the
 * handler table is TOTAL over `StepBillingMode` — which is what makes the
 * "unimplemented" state a compile-visible, enumerable fact rather than a
 * missing object key that reads as `undefined` at runtime.
 */
function unimplementedMode(mode: StepBillingMode): BillingModeHandler {
  const fail = (): never => {
    throw new Error(
      `billing mode '${mode}' has no money-path handler — implement one in ` +
        'services/blocks/steps before registering a step that declares it'
    );
  };
  return { estimateBuzz: fail, planSpend: fail };
}

const billingModeHandlers: Record<StepBillingMode, BillingModeHandler> = {
  prepaidFixed: {
    estimateBuzz: (step, params) => step.estimateBuzz(params),
    planSpend: (step, params) => {
      const entry = step as PrepaidFixedStep<unknown>;
      return {
        reserveBuzz: entry.priceForVariant(entry.resolveVariant(params)),
        // Exact price → the reservation is final; never touch the post-paid
        // settle machinery.
        postPaidSettle: false,
        // Exact price → an overage IS a permanent cap shortfall, so correct it.
        correctReservationOverage: true,
        stepTimeoutSeconds: null,
      };
    },
  },
  timeBounded: unimplementedMode('timeBounded'),
  tokenMetered: unimplementedMode('tokenMetered'),
};

/** True iff the mode has an implemented money-path handler. */
export function isBillingModeImplemented(mode: StepBillingMode): boolean {
  return mode === 'prepaidFixed';
}

/** The display estimate for a step, dispatched on its declared billing mode. */
export function estimateStepBuzz(step: AnyBlockStep, params: unknown): number {
  return billingModeHandlers[step.billingMode].estimateBuzz(step, params);
}

/** The spend plan for a step submit, dispatched on its declared billing mode. */
export function planStepSpend(step: AnyBlockStep, params: unknown): StepSpendPlan {
  return billingModeHandlers[step.billingMode].planSpend(step, params);
}

// ─────────────────────────────────────────────────────────────────────────────
// Moderation dispatch. Same shape, same reasoning: total over the posture
// union, and every posture without an implemented handler is rejected at load.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * True iff the posture has an implemented handler.
 *
 * 🔴 THE SINGLE DECLARATION. `./moderation` asserts at ITS module load that its
 * handler table agrees with this function for every posture, so "declared
 * implemented" and "has a handler" cannot drift into a posture that registers
 * cleanly and then has nothing to run.
 */
export function isModerationPostureImplemented(posture: StepModerationPosture): boolean {
  // 'none' is implemented by construction: a step with no free-text input and
  // no free-text output introduces no surface, so there is nothing to run.
  // 'promptAudit' runs `auditPromptServer` — the SAME audit `textToImage` and
  // `customComfy` run, host-side and before submission (see `./moderation`).
  // 'textOutput' still has no answer and still fails at load.
  return posture === 'none' || posture === 'promptAudit';
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry object. Its keys ARE the source of truth for the wire enum.
//
// TRANCHE 1 (RFC migration step 2): deterministic, `prepaidFixed`, no new
// moderation surface. See `convert-image.step.ts` for why that entry qualifies.
//
// 🔴 The RFC named Tranche 1 as "background removal, upscale, convert". Only
// CONVERT made it. Enumerating the orchestrator's real `$type` values from the
// generated `@civitai/client` types found that the other two DO exist —
// `imageBackgroundRemoval` and `imageUpscaler` — but neither is `prepaidFixed`:
//   - `imageBackgroundRemoval`: the client's own doc string says it "builds a
//     ComfyUI graph under the hood and runs it as a comfy job", i.e. GPU work
//     with variable duration. That is `timeBounded`, not a deterministic price.
//   - `imageUpscaler`: also GPU work, AND its `model` field takes an arbitrary
//     AIR URN. An AIR chosen by an untrusted iframe reaches the orchestrator
//     without the generation-graph entitlement belt — the same bypass class the
//     customComfy `resources` array carries — so it needs a resource gate first.
// Both are good Tranche 2 candidates once `timeBounded` has a money-path
// handler. Registering either now would have meant declaring a fixed price for
// something whose cost is not fixed.
//
// Also considered and NOT registered: `mediaHash` passes all four bars
// (standalone `$type` with a consumer-recipe endpoint, deterministic CPU
// hashing, bounded hash-string output, no resources) but has no demonstrated
// developer demand, and every registered id is a permanent public wire
// commitment. Adding it later is one file plus one line here — which is the
// entire point of the registry.
// ─────────────────────────────────────────────────────────────────────────────
const stepRegistry = {
  'convert-image': convertImageStep,
};

export type RegisteredStepId = keyof typeof stepRegistry & string;

/**
 * The registered step ids, DERIVED from the registry keys. Consumed by
 * `workflow.schema`'s `blockStepBodySchema` as the fail-closed `step` enum (an
 * unregistered id is rejected at the union). Typed as a non-empty tuple so
 * `z.enum` accepts it.
 */
export const REGISTERED_STEP_IDS = Object.keys(stepRegistry) as [
  RegisteredStepId,
  ...RegisteredStepId[]
];

/** Resolve a step by id. Returns `undefined` for an unregistered id. */
export function getStep(id: string): AnyBlockStep | undefined {
  return (stepRegistry as Record<string, AnyBlockStep>)[id];
}

/**
 * Resolve a step by the orchestrator `$type` it submits as — the lookup the two
 * `workflow.service` extractors use, since a returned Workflow carries the
 * `$type`, never the registry id.
 *
 * Returns `undefined` for an unregistered `$type`, so a caller keeps whatever
 * fallback it had. Uniqueness of `orchestratorType` across the registry is
 * enforced at load (`assertOrchestratorTypesUnique`) — without it this lookup
 * would silently pick whichever entry happened to be declared last.
 */
export function getStepByOrchestratorType(orchestratorType: string): AnyBlockStep | undefined {
  for (const [, step] of listRegisteredSteps()) {
    if (step.orchestratorType === orchestratorType) return step;
  }
  return undefined;
}

/**
 * The registered steps as `[id, step]` pairs.
 *
 * Exported so tests can enumerate the REAL population rather than a hardcoded
 * list — a newly added entry that violates an invariant then fails loudly in
 * CI instead of being silently uncovered.
 */
export function listRegisteredSteps(): [string, AnyBlockStep][] {
  return Object.entries(stepRegistry as Record<string, AnyBlockStep>);
}

// ─────────────────────────────────────────────────────────────────────────────
// LOAD-TIME INVARIANTS (fail-fast at module import, mirroring the recipe
// registry's `maxBuzz === ceil(stepTimeoutSeconds)` loop).
//
// Exported as a function over an arbitrary entry so the tests can (a) run it
// against the real population and (b) mutation-test each clause with a fixture
// that violates exactly one of them. A guard that can only be exercised by
// editing the shipped registry is a guard nobody exercises.
// ─────────────────────────────────────────────────────────────────────────────

/** The key used to probe that a step's `paramSchema` really is `.strict()`. */
export const STRICTNESS_PROBE_KEY = '__unregisteredBlockStepParamProbe__';

export function assertStepInvariants(id: string, step: AnyBlockStep): void {
  const where = `block step '${id}'`;

  // (0) The registry key IS the wire id. A mismatch would mean the enum says one
  // thing and every log/metric/error says another.
  if (step.id !== id) {
    throw new Error(`${where}: registry key must equal step.id (got '${step.id}')`);
  }

  // (1) The declared moderation posture must have an implemented handler. A
  // text-producing step cannot be registered until someone answers the policy
  // question in code.
  if (!isModerationPostureImplemented(step.moderationPosture)) {
    throw new Error(
      `${where}: moderationPosture '${step.moderationPosture}' has no implemented handler — ` +
        'a step with a free-text input or output needs a declared, implemented posture'
    );
  }

  // (1a) POSTURE ↔ `auditableText` AGREEMENT, both directions. 🔴 THE TWO
  // DIRECTIONS ARE NOT OF EQUAL WEIGHT, and labelling that is the point of this
  // note — one is a control, the other is diagnostics.
  //
  // Forward (posture requires the field, entry omits it) — 🔴 DIAGNOSTICS ONLY,
  // NOT A CONTROL. Do not count it among the guards that make the fail-closed
  // property hold. Clause 5a below is gated on the IDENTICAL predicate
  // (`postureRequiresAuditableText`), and clause 2 guarantees at least one
  // variant, so 5a is ALWAYS reached for a `'promptAudit'` entry and rejects
  // this same shape on its own — via a raw `TypeError: step.auditableText is not
  // a function` out of its `step.auditableText!(...)` call. Registration fails
  // closed with or without this branch; its entire contribution is a NAMED,
  // actionable error in place of that TypeError. Worth keeping for exactly that,
  // and worth being honest that a mutation removing it degrades the message
  // rather than opening a hole.
  //
  // Reverse (field declared under a posture that never audits) — 🔴 A GENUINE
  // CONTROL, and the ONLY clause that catches this shape: nothing else below
  // runs for a non-auditing posture, so without it the entry registers cleanly,
  // reads as covered, and its text reaches the orchestrator unaudited. Rejecting
  // is the fail-closed direction. Leave this branch exactly as it is.
  if (postureRequiresAuditableText(step.moderationPosture)) {
    if (typeof step.auditableText !== 'function') {
      throw new Error(
        `${where}: moderationPosture '${step.moderationPosture}' requires an auditableText() ` +
          'declaration naming the params that carry user text — a posture that can be ' +
          'satisfied by auditing nothing is not a posture'
      );
    }
  } else if (step.auditableText !== undefined) {
    throw new Error(
      `${where}: declares auditableText() but moderationPosture '${step.moderationPosture}' ` +
        'never audits it — the text would reach the orchestrator unaudited'
    );
  }

  // (1b) POSTURE ↔ ORCHESTRATOR `$type` AGREEMENT. Without it, a
  // `chatCompletion` entry declaring `'promptAudit'` registers cleanly, reads
  // as covered, and emits unscanned free text.
  //
  // 🔴 WHAT THIS CLAUSE IS AND IS NOT — READ BEFORE TRUSTING IT. It reads the
  // posture against `orchestratorType`, which the entry author ALSO WRITES. On
  // its own that makes it a check against a second declaration, not against
  // reality: an author could declare a benign `orchestratorType`, build
  // `$type: 'chatCompletion'`, and walk straight past it. An earlier revision
  // of this comment claimed the opposite — that this was "the only clause that
  // reads the declaration against something the entry author did not also
  // write" — and that claim was FALSE and was caught in review. It is recorded
  // here rather than quietly deleted because in a code-reviewed trust root the
  // comment IS the control: a reviewer who reads "already anchored" is a
  // reviewer who stops checking.
  //
  // What makes it a real control is CLAUSE 7a, which asserts
  // `buildStep(...).$type === orchestratorType` per variant. 1b + 7a together
  // tie the posture to the type actually submitted. Neither is sufficient
  // alone; if 7a is ever weakened, this clause degrades to a speed bump.
  //
  // Placed AFTER clause 1 on purpose. For the honest declaration
  // (`chatCompletion` + `'textOutput'`) clause 1 fires first with the accurate
  // "no implemented handler" message; this clause is what catches the DISHONEST
  // one. Reversing the order would report both shapes as a type mismatch and
  // hide the real reason the honest entry cannot register yet.
  //
  // 🟢 Known rough edge, deliberately not reordered: a `$type`-constrained
  // entry declaring `'promptAudit'` WITHOUT `auditableText` fires clause 1a
  // first, telling the author to add a field that this clause then rejects
  // anyway. Moving 1b above 1a would fix the two-step, but 1a's reverse
  // direction is a genuine control for a different shape, and splitting the
  // moderation clauses around it costs more clarity than the dead end does.
  const acceptablePostures = acceptablePosturesFor(step.orchestratorType);
  if (acceptablePostures !== undefined && !acceptablePostures.includes(step.moderationPosture)) {
    throw new Error(
      `${where}: orchestratorType '${step.orchestratorType}' requires moderationPosture ` +
        `${acceptablePostures.map((p) => `'${p}'`).join(' or ')}, but the entry declares ` +
        `'${step.moderationPosture}' — the declared posture does not cover the moderation ` +
        'surface this step actually produces'
    );
  }

  // (2) At least one variant, or nothing below can be enumerated.
  if (step.variants.length === 0) {
    throw new Error(`${where}: must declare at least one variant`);
  }

  for (const variant of step.variants) {
    const vWhere = `${where} variant '${variant}'`;
    const params = step.canonicalParamsFor(variant);

    // (3) The canonical params must PARSE. If they don't, every clause below is
    // testing a value the schema would have rejected.
    const parsed = step.paramSchema.safeParse(params);
    if (!parsed.success) {
      throw new Error(
        `${vWhere}: canonicalParamsFor() must satisfy paramSchema (${parsed.error.message})`
      );
    }

    // (4) `.strict()` — an UNKNOWN param must be REJECTED, not silently dropped.
    // Probed behaviourally rather than by inspecting the zod internals, so it
    // holds for any schema shape that achieves strictness.
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
      throw new Error(`${vWhere}: canonicalParamsFor() must return a plain params object`);
    }
    const withUnknown = { ...(params as Record<string, unknown>), [STRICTNESS_PROBE_KEY]: 1 };
    if (step.paramSchema.safeParse(withUnknown).success) {
      throw new Error(
        `${vWhere}: paramSchema must be .strict() — it accepted an unknown param ` +
          `('${STRICTNESS_PROBE_KEY}'), which means an unknown param is silently DROPPED`
      );
    }

    // (5) The canonical params for a variant must RESOLVE to that variant, or
    // the price/budget asserted below is not the one this params object buys.
    const resolved = step.resolveVariant(parsed.data);
    if (resolved !== variant) {
      throw new Error(
        `${vWhere}: canonicalParamsFor() resolves to variant '${resolved}', not '${variant}'`
      );
    }

    // (5a) THE NON-VACUITY PROBE for `auditableText`, the moderation analogue of
    // clause 8's extraction probe. `auditPromptServer` RETURNS EARLY on an empty
    // prompt, so an entry that declares `'promptAudit'` and returns `''` would
    // pass clause 1a, run the audit, and audit nothing — reporting success. The
    // declaration alone is therefore not enough; it has to produce real text for
    // params the entry itself calls canonical.
    if (postureRequiresAuditableText(step.moderationPosture)) {
      // 1a proved this is a function; the non-null assertion is that guard's
      // result, not an assumption.
      const text = step.auditableText!(parsed.data);
      if (typeof text?.prompt !== 'string' || text.prompt.trim().length === 0) {
        throw new Error(
          `${vWhere}: auditableText() returned no prompt text for canonicalParamsFor() — ` +
            'auditPromptServer returns early on an empty prompt, so this posture would ' +
            'audit NOTHING while reporting success'
        );
      }
      if (text.negativePrompt !== undefined && typeof text.negativePrompt !== 'string') {
        throw new Error(
          `${vWhere}: auditableText() returned a non-string negativePrompt — ` +
            'auditPromptServer would audit a value it cannot read'
        );
      }
    }

    // (6) Per-mode budget invariant. Runs BEFORE the implemented-handler gate
    // below, deliberately: if the gate ran first, these branches would be
    // structurally UNREACHABLE for `timeBounded` / `tokenMetered` (the gate
    // rejects every such entry, so their clauses could never execute) and the
    // registry would carry two invariants nothing could ever exercise. Ordered
    // this way, a fixture declaring an unimplemented mode still reaches — and
    // can mutation-prove — its own budget guard.
    switch (step.billingMode) {
      case 'prepaidFixed': {
        const price = step.priceForVariant(variant);
        if (!Number.isSafeInteger(price) || price <= 0) {
          throw new Error(
            `${vWhere}: prepaidFixed price (${price}) must be a positive safe integer — ` +
              'it is the exact amount reserved against every spend cap'
          );
        }
        const estimate = step.estimateBuzz(parsed.data);
        if (estimate !== price) {
          throw new Error(
            `${vWhere}: prepaidFixed estimateBuzz (${estimate}) must equal the declared ` +
              `price (${price}) — the block is SHOWN the estimate and CHARGED the price`
          );
        }
        break;
      }
      case 'timeBounded': {
        const budget = step.budgetForVariant(variant);
        const enforced = Math.ceil(budget.stepTimeoutSeconds);
        if (!Number.isSafeInteger(enforced) || enforced <= 0) {
          throw new Error(
            `${vWhere}: timeBounded stepTimeoutSeconds (${budget.stepTimeoutSeconds}) must be positive`
          );
        }
        if (budget.maxBuzz !== enforced) {
          throw new Error(
            `${vWhere}: timeBounded maxBuzz (${budget.maxBuzz}) must equal ` +
              `ceil(stepTimeoutSeconds) (${enforced}) — the step timeout is the physical Buzz ceiling`
          );
        }
        break;
      }
      case 'tokenMetered': {
        const maxBuzz = step.maxBuzzForVariant(variant);
        if (!Number.isSafeInteger(maxBuzz) || maxBuzz <= 0) {
          throw new Error(
            `${vWhere}: tokenMetered maxBuzz (${maxBuzz}) must be a positive safe integer`
          );
        }
        break;
      }
    }

    // (7) RESOURCE POLICY, enforced rather than merely declared. A `'none'`
    // entry claims it reaches no AIR resource; prove it against the step this
    // entry actually BUILDS, by deep-scanning for an AIR URN anywhere in the
    // submitted input. This is what stops a future `imageUpscaler`-shaped entry
    // — an arbitrary AIR URN forwarded from an untrusted iframe, straight past
    // the generation-graph entitlement belt — from registering with a `'none'`
    // declaration and passing every other invariant.
    //
    // 🔴 HONEST LIMIT, stated so nobody over-trusts it: this probes the
    // CANONICAL params, so it cannot see an AIR that only appears when an
    // OPTIONAL air-bearing field is supplied. It is a floor, not a proof. The
    // load-bearing guard for that case is the required declaration itself plus
    // the unimplemented `staticAllowlist` gate (clause 11): an entry whose
    // params can carry an AIR cannot honestly declare `'none'`, and declaring
    // `'staticAllowlist'` fails at load until someone implements and reviews it.
    const built = step.buildStep(parsed.data);

    // (7a) THE DECLARED `$type` MUST BE THE ONE ACTUALLY BUILT.
    //
    // 🔴 THIS IS WHAT ANCHORS CLAUSE 1b, AND WITHOUT IT THAT CLAUSE IS A SPEED
    // BUMP RATHER THAN A CONTROL. `orchestratorType` is a self-declared field
    // and the router submits `buildStep(...).$type` (`blocks.router.ts`, the
    // step submit branch) — NOT the declared one. So before this clause an
    // entry could declare a benign, unconstrained `orchestratorType`, build
    // `$type: 'chatCompletion'`, and register cleanly with
    // `moderationPosture: 'none'`: clause 1b saw the benign declaration, and
    // the orchestrator got the chat step. Verified by execution against this
    // file, not reasoned about.
    //
    // It hardens clause 9 for free by the same argument — that clause also
    // reads the DECLARED type, so a divergent entry could shadow a natively
    // extracted `$type` while declaring something else.
    //
    // 🔴 HONEST LIMIT, same shape as clause 7's: this probes the CANONICAL
    // params, so a `buildStep` that switches `$type` ON PARAMS can still
    // diverge at request time. It is a floor, not a proof. Closing that
    // completely means re-asserting at the router on the real submitted value,
    // exactly as the resource-policy scan already does — recorded, not done
    // here, because it belongs with the router's own submit-path guards.
    if (built.$type !== step.orchestratorType) {
      throw new Error(
        `${vWhere}: declares orchestratorType '${step.orchestratorType}' but buildStep() emits ` +
          `'${built.$type}' — the router submits the BUILT type, so every $type-keyed guard ` +
          '(the moderation-posture constraint, the natively-extracted check) would be reading ' +
          'a type this step does not actually submit, and output extraction would never resolve'
      );
    }

    if (step.resourcePolicy.kind === 'none') {
      if (containsAirReference(built.input)) {
        throw new Error(
          `${vWhere}: resourcePolicy 'none' is contradicted — buildStep() emitted an AIR ` +
            'reference. A step that reaches an AIR resource bypasses the generation-graph ' +
            'entitlement belt and needs a declared, implemented resource allowlist'
        );
      }
    }

    // (8) OUTPUT EXTRACTION must actually surface something. A registered step
    // whose output nothing can read is a capability the caller is CHARGED for
    // and can never retrieve — it polls to `succeeded` with an empty result
    // forever. That failure is invisible to every other invariant here, and it
    // is exactly what shipped before this clause existed.
    const sampleStep = step.canonicalOutputFor(variant);
    const media = step.extractOutput(sampleStep);
    if (!Array.isArray(media) || media.length === 0) {
      throw new Error(
        `${vWhere}: extractOutput() returned no media for canonicalOutputFor() — the step's ` +
          'result would be unreachable on both the snapshot and the app-workflow projection'
      );
    }
    for (const item of media) {
      if (typeof item?.url !== 'string' || item.url.length === 0) {
        throw new Error(
          `${vWhere}: extractOutput() returned media with no url — a block would render a dead link`
        );
      }
    }
  }

  // (9) The orchestrator `$type` must not shadow one of the `$type` values
  // `workflow.service`'s extractors handle NATIVELY. The registry branch there
  // is evaluated BEFORE the native `$type` filter (it has to be — that filter
  // `continue`s on everything else), so without this guard a registered entry
  // could silently take over `textToImage` extraction. With it, the placement is
  // provably behaviour-preserving for the existing kinds.
  if (NATIVELY_EXTRACTED_STEP_TYPES.includes(step.orchestratorType)) {
    throw new Error(
      `${where}: orchestratorType '${step.orchestratorType}' is natively extracted by ` +
        'workflow.service — a registered step must not shadow it'
    );
  }

  // (10) LAST-1: the declared billing mode must have an implemented money-path
  // handler. This is what stops a newly declared mode from riding another
  // mode's reservation logic — it is a BUILD failure, not a runtime one.
  //
  // Placed late so the structural per-variant invariants above stay reachable
  // (see clause 6). Position does not weaken it: every clause here throws at
  // module load, so an entry declaring an unimplemented mode still cannot
  // register regardless of which guard reports first.
  if (!isBillingModeImplemented(step.billingMode)) {
    throw new Error(
      `${where}: billingMode '${step.billingMode}' has no implemented money-path handler`
    );
  }

  // (11) LAST: the declared resource policy must have an implemented handler.
  // Same fail-closed shape and same reason as the billing-mode gate, on the
  // entitlement axis. Placed last for the same reachability reason: with it
  // first, clause 7's `'none'` branch would still run (it only applies to
  // `'none'`), but any future per-policy structural invariant would not.
  if (!isResourcePolicyImplemented(step.resourcePolicy)) {
    throw new Error(
      `${where}: resourcePolicy '${step.resourcePolicy.kind}' has no implemented handler — ` +
        'a step that reaches AIR resources needs a reviewed entitlement gate first'
    );
  }
}

/**
 * Cross-entry invariant: no two registered steps may claim the same orchestrator
 * `$type`. `getStepByOrchestratorType` is a single-winner lookup, so a duplicate
 * would silently route one step's output extraction through the other's
 * extractor — a wrong-shape read on a money path.
 *
 * Separate from `assertStepInvariants` because it is a property of the
 * POPULATION, not of any one entry.
 */
export function assertOrchestratorTypesUnique(entries: [string, AnyBlockStep][]): void {
  const seen = new Map<string, string>();
  for (const [id, step] of entries) {
    const prior = seen.get(step.orchestratorType);
    if (prior !== undefined) {
      throw new Error(
        `block step '${id}': orchestratorType '${step.orchestratorType}' is already claimed by ` +
          `'${prior}' — output extraction would silently resolve to one of them`
      );
    }
    seen.set(step.orchestratorType, id);
  }
}

// Fail-fast every invariant at module load. A registry that violates one is a
// BUILD-time error, not a runtime surprise on a spend path.
for (const [id, step] of listRegisteredSteps()) {
  assertStepInvariants(id, step);
}
assertOrchestratorTypesUnique(listRegisteredSteps());
