import type * as z from 'zod';
import { chatCompletionStep } from './chat-completion.step';
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
// 🔴 BOTH HALVES OF THAT QUESTION ARE NOW ANSWERED, AND ALL THREE POSTURES ARE
// IMPLEMENTED — nothing in this union fails at load today. The INPUT half
// (#3527): mature content is permitted for App Blocks, bounded by the token's
// server-minted maturity ceiling, so a free-text INPUT needs the same prompt
// audit `textToImage` / `customComfy` already run, not a new policy —
// `'promptAudit'`'s handler lives in `./moderation` and runs `auditPromptServer`
// host-side, before the orchestrator submit. The OUTPUT half is answered too:
// `'textOutput'` scans the generated text with the orchestrator's
// `xGuardModeration` step (`mode: 'text'`) at the READ boundary and withholds on
// a policy-label hit. Evidence, not intent: `isModerationPostureImplemented`
// returns true for all three values, its output handler is in `./moderation`,
// and the registered `chat-completion` entry declares `'textOutput'` — a
// load-time failure would take the module down.
//
// 🔴 DO NOT SUMMARISE THE FAILURE BEHAVIOUR AS "withholds on ANY scanner
// failure". An earlier revision of this paragraph said exactly that and it is
// NOT true of this tree. What withholds is a specific set — in
// `./text-output-moderation` unless noted, named by symbol rather than line so
// this list does not rot the moment that file moves:
//   - the scan call throwing, or exceeding the hard deadline (`stage: 'error'`)
//   - no scan output at all — the submit failed, or the workflow was still
//     running when `SCAN_WAIT_SECONDS` elapsed (`stage: 'no-verdict'`)
//   - joined text over `MAX_SCANNED_CONTENT_CHARS`, checked before the network
//     call AND before the memo, so no over-cap payload is answered from a hit
//     (`stage: 'over-cap'`)
//   - a requested label absent from `results[]` (`missingRequestedLabels` →
//     `stage: 'label-drift'`)
//   - `extractText` returning a non-array, or an array with a non-string entry
//     (guarded in `./moderation`'s `textOutput.output` handler)
// That module is authoritative; this list is a summary and must be re-read
// against it, not trusted over it.
//
// 🔴 KNOWN GAP, OPEN IN THIS TREE: A LABEL THE SCANNER ATTEMPTED AND FAILED ON
// RELEASES. The generated `XGuardLabelResult` carries `error?: null | string`,
// but `XGuardLabelResultLike` — the shape this policy actually reads — declares
// only `label` / `score` / `triggered`, and `decideTextOutputVerdict` reads only
// those three. So an errored label contributes nothing to the trigger set, and
// it ALSO suppresses the drift guard, because `missingRequestedLabels` counts an
// entry as "evaluated" on a non-empty `label` alone. A scan in which all 15
// `TEXT_OUTPUT_SCAN_LABELS` errored is therefore indistinguishable from
// all-clean and RELEASES. This is stated as OPEN because it is open here; it is
// a live fail-open, not a hypothetical. Re-read `decideTextOutputVerdict` before
// relying on this paragraph in EITHER direction — do not assume from its
// presence that it is still open, nor from its absence that it was ever closed.
//
// 🔴 AN EARLIER REVISION OF THIS PARAGRAPH ENDED "The free-text OUTPUT half
// (`'textOutput'`) is still unanswered and still fails at load." That was FALSE,
// and it was the FIRST thing a reader hit when opening this union — twenty lines
// ahead of the `'textOutput'` member's own doc, which said the opposite. When a
// posture ships, correct THIS block in the same change; a stale summary above a
// correct member doc is read as the summary.
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
   * Free-text OUTPUT — a moderation surface the prompt audit does not cover at
   * all, because the text does not exist yet when the prompt audit runs.
   *
   * IMPLEMENTED, in the OUTPUT phase. An entry declaring it MUST also declare
   * `extractText` (see that field). Its handler lives in `./moderation` and
   * scans the generated text with the orchestrator's `xGuardModeration` step
   * (`mode: 'text'`) at the READ boundary — after generation, before the text
   * reaches the block — withholding it on a policy hit and on any scanner
   * failure. See `./text-output-moderation` for the label policy and for why it
   * fails CLOSED where the prompt audit fails soft.
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
 * WHAT SHAPE a posture's step publishes — MEDIA **XOR** TEXT. The single
 * declaration every output-shape rule reads.
 *
 * 🔴 WHY THIS EXISTS, AND THE DEFECT IT CLOSES. `extractOutput` used to be
 * unconditionally REQUIRED and clause 8 unconditionally demanded ≥1 media item
 * with a non-empty `url` — for EVERY entry, with no posture gate, in contrast to
 * clause 8a which was already gated. But `ACCEPTABLE_POSTURES_BY_TYPE` licenses
 * `'textOutput'` only for `chatCompletion` / `mediaCaptioning` /
 * `audioCaptioning` / `transcription` / `promptEnhancement` / `xGuardModeration`
 * / `echo` — every one of them TEXT-producing and none of them media-producing.
 * So the posture was UN-ADOPTABLE: an honest `chatCompletion` + `'textOutput'`
 * entry hit a load-time wall it could not satisfy truthfully, and the obvious
 * workaround — prose stuffed into a fabricated `media.url` — registered cleanly
 * and shipped that prose UNSCANNED, because `StepOutputMedia.url` is a bare
 * string that flows to `snapshot.imageUrls` and `AppWorkflow.images[].url`
 * WITHOUT passing through `attachModeratedStepTextOutputs`. Proven by execution
 * in review, both directions.
 *
 * 🔴 XOR, NOT "AT LEAST ONE", AND THAT IS DELIBERATE. A `'media'` entry declares
 * `extractOutput` and MUST NOT declare `extractText`; a `'text'` entry declares
 * `extractText` and MUST NOT declare `extractOutput`. Enforced three ways off
 * THIS one predicate:
 *   1. AT THE TYPE LEVEL — `BlockStep` intersects a `StepOutputSurface` union
 *      whose text member types `extractOutput?: never`. A text entry cannot
 *      even WRITE a media extractor, which is what makes the url-smuggle
 *      structurally impossible rather than merely guarded.
 *   2. AT REGISTRY LOAD — for the `as`-cast escape hatch a type cannot close.
 *      🔴 NAME THE RIGHT CLAUSES: an earlier revision of this line said
 *      "clauses 8/8a", which is wrong in both directions and would send someone
 *      auditing the XOR to the wrong code. The runtime XOR is clause **8-i**
 *      (a media posture MUST declare `extractOutput`) and clause **8-ii** (a
 *      text posture MUST NOT) on the `extractOutput` axis, plus clause **1c**
 *      (both directions) on the `extractText` axis. Clause **8a** is NOT an XOR
 *      clause at all — it is the non-vacuity probe that a declared `extractText`
 *      actually returns text.
 *   3. AT THE READ PATH — `snapshotFromWorkflow` / `projectAppWorkflow` consult
 *      THIS predicate before calling `extractOutput`, so a media extractor that
 *      somehow existed on a text entry would still contribute nothing.
 *
 * 🔴 HONEST LIMIT, STATED RATHER THAN PAPERED OVER. A future orchestrator step
 * that emits BOTH media and free text cannot register at all under this rule —
 * it fails at load rather than half-registering. That is the fail-closed
 * direction and it is the intended answer for now: such an entry needs a real
 * decision about whether its media is scanned too (the text scan here does not
 * look at media at all), and it should be blocked until someone makes it, not
 * admitted with one axis silently uncovered.
 *
 * 🔴 AND THE LICENSED SET ALREADY CONTAINS ONE — DO NOT READ THIS AS A FUTURE
 * PROBLEM. This paragraph used to end "Nothing in the currently-licensed
 * `$type` set has that shape", and that was FALSE. `chatCompletion` has exactly
 * that shape: `ChatCompletionInput.modalities` accepts `['image']`, and with it
 * the orchestrator returns generated images on
 * `choices[].message.images[].image_url.url` as base64 data URIs — bytes that
 * never reach image ingestion, never become moderated `Image` rows, and are not
 * seen by the text scan either.
 *
 * What keeps the XOR true today is NOT the `$type` set. It is that the
 * `chatCompletion` ENTRY's `.strict()` `paramSchema` omits `modalities`, so the
 * media arm is unreachable through it — a load-bearing omission, not a tidy
 * one. Read `./chat-completion.step`'s note before touching that schema: adding
 * `modalities` (or its companion `image_config`) turns a text-posture entry
 * into a media-producing one and opens precisely the half-covered channel this
 * rule exists to refuse. The invariant to defend is per-ENTRY schema
 * discipline; do not infer from the XOR that the licensed `$type`s are
 * single-natured.
 */
export function stepOutputShape(posture: StepModerationPosture): 'media' | 'text' {
  switch (posture) {
    // No free-text output — whatever this step produces is media, extracted by
    // the declared `extractOutput` and rated by the orchestrator's own blob
    // `nsfwLevel` on the existing path.
    case 'none':
      return 'media';
    // Input-side posture. Its RESULT is media (see `posturePhaseRequirements`'s
    // `'promptAudit'` case: no output-phase surface).
    case 'promptAudit':
      return 'media';
    // The only text-publishing posture, and the only one whose result reaches a
    // block through the scan.
    case 'textOutput':
      return 'text';
  }
}

/**
 * True iff the posture's handler needs the entry to declare `extractText`.
 *
 * The OUTPUT-side twin of `postureRequiresAuditableText`. 🔴 DERIVED FROM
 * `stepOutputShape`, not a second copy of the rule: the load-time invariant, the
 * read-path handler, the type-level surface union and the tests all bottom out
 * in one predicate, so "which postures publish text" cannot drift between them.
 */
export function postureRequiresTextExtraction(posture: StepModerationPosture): boolean {
  return stepOutputShape(posture) === 'text';
}

/**
 * True iff the posture's step publishes MEDIA — i.e. iff it declares (and the
 * two `workflow.service` extractors may call) `extractOutput`.
 *
 * The exact complement of `postureRequiresTextExtraction`, off the same
 * predicate.
 */
export function postureProducesMedia(posture: StepModerationPosture): boolean {
  return stepOutputShape(posture) === 'media';
}

/**
 * WHICH PHASES a posture is REQUIRED to run a handler in.
 *
 * 🔴 THIS IS THE CONTROL THAT MAKES `'textOutput'` IMPOSSIBLE TO SATISFY WITH AN
 * INERT HANDLER, and it is the whole reason the posture table in `./moderation`
 * is keyed by phase instead of being a flat posture → handler map.
 *
 * The moderation dispatch has two positions, and they are NOT interchangeable:
 *
 *   SUBMIT — `runStepModeration`, in the step submit path, before the
 *            orchestrator quote and before any spend reservation. The only
 *            place INPUT can be audited, and the only place a rejection is free.
 *   OUTPUT — `runStepOutputModeration`, at the read boundary, after the
 *            orchestrator has produced a result. The only place GENERATED text
 *            exists at all.
 *
 * A `'textOutput'` handler placed in the SUBMIT phase would run before the
 * generation, scan nothing, and return cleanly — a registered, load-time-gated
 * posture that is a NO-OP, reporting success on every call. Declaring the
 * required phase here and asserting the table against it at load makes that
 * shape a BUILD failure instead of something review has to notice. The assert
 * is two-directional (`./moderation`): a required phase with no handler fails,
 * and a handler in a phase the posture does NOT require fails too — because a
 * handler that never runs reads as coverage.
 */
export function posturePhaseRequirements(posture: StepModerationPosture): {
  submit: boolean;
  output: boolean;
} {
  switch (posture) {
    // No free-text input and no free-text output — no surface in either phase.
    case 'none':
      return { submit: false, output: false };
    // Input only. The generated media of a `'promptAudit'` step is not text and
    // is not this posture's concern.
    case 'promptAudit':
      return { submit: true, output: false };
    // Output only. There is no input surface to audit at submit — an entry that
    // ALSO takes free-text input is declaring the wrong posture for its input,
    // which `ACCEPTABLE_POSTURES_BY_TYPE` deliberately does not try to model
    // (see the SET-NOT-A-LADDER note there).
    case 'textOutput':
      return { submit: false, output: true };
  }
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
//
// 🔴 THIS AXIS IS AIR-SPECIFIC, AND READING IT WIDER IS THE MISTAKE TO AVOID.
// Both policy kinds are about AIR URNs and nothing else: `staticAllowlist`'s
// only field is `airs`, clause 7's enforcement is `containsAirReference` (a
// `urn:air:` substring scan), and the harm it names is the generation-graph
// ENTITLEMENT belt — reaching a gated / early-access / Private model version.
// So `resourcePolicy: 'none'` means "no AIR reference", NOT "this entry's model
// surface is bounded", and a reviewer who reads it as the latter has stopped
// checking the thing that matters.
//
// The concrete case, because it is coming: the orchestrator's `chatCompletion`
// input takes `model: string` — a plain provider id ("gpt-4o"), NOT an AIR
// (`ChatCompletionInput` in the generated `@civitai/client` types). Such an
// entry would declare `'none'` TRUTHFULLY and pass clause 7, while forwarding
// an arbitrary model name from an untrusted iframe. There is also no
// orchestrator-side model validation to catch it — a fabricated name quotes
// fine and fails only at execution.
//
// 🔴 DO NOT FORCE A NON-AIR MODEL ALLOWLIST INTO `staticAllowlist`. Putting
// "gpt-4o" in a field named `airs` would make the eventual AIR-allowlist
// implementation (which has to compare against the entitlement belt) wrong for
// whichever entries lied to it. The smallest honest shape is the one the
// registry ALREADY provides, with no new field: put the permitted models in the
// entry's own `.strict()` `paramSchema` as a `z.enum`, AND declare them as the
// entry's `variants` with `resolveVariant` returning the chosen one. That gets
// the pinning from the schema (a non-member is a BAD_REQUEST at parse), the
// bound from `resolveStepVariant`, and per-model pricing from
// `priceForVariant` — which a flat price today does not need but a rate card
// eventually will.
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

/**
 * The AIR URN scheme prefix. Lowercase; the scan lowercases its input.
 *
 * EXPORTED so the request-time rejection in `blocks.router.ts` can NAME the
 * literal it matched on rather than restating it. That message is the only
 * diagnostic an app author gets for a bounced submit, and a hardcoded second
 * copy of this string would eventually name a literal the scan no longer uses —
 * a diagnostic that is confidently wrong is worse than none.
 */
export const AIR_URN_PREFIX = 'urn:air:';

/**
 * Recursion budget for {@link containsAirReference}.
 *
 * 🔴 THE SCAN IS TOTAL, NOT PARTIAL — it must never throw. Its declared contract
 * is a `boolean` (and, one layer up, a `PolicyDecision`), never "may throw", and
 * `evaluateSubmittedStep` does not wrap it. An unbounded recursion over
 * attacker-shaped JSON hits `RangeError: Maximum call stack size exceeded` at
 * roughly 5k nesting levels, which a ~10 KB `[[[[…]]]]` request body reaches
 * trivially — a free 500 from a value the guard was supposed to *decide* on.
 *
 * At the cap the scan returns TRUE (fail-closed): "I could not prove this input
 * carries no AIR." No legitimate orchestrator step input nests anywhere near
 * this deep, so the cap costs nothing real and turns a crash into a rejection.
 */
const AIR_SCAN_MAX_DEPTH = 128;

/**
 * True when any string ANYWHERE in the value — a leaf, an array element, an
 * object VALUE, **or an object KEY** — is (or embeds) an AIR URN.
 *
 * Deliberately a deep scan rather than a check of a known field name: the point
 * is to catch an AIR arriving through a field NOBODY thought to look at, which
 * is the only way the `'none'` declaration can become a lie.
 *
 * 🔴 KEYS ARE SCANNED, AND THAT IS NOT DEFENSIVE PARANOIA — IT IS THE
 * ORCHESTRATOR'S OWN SCHEMA. `ImageJobParams.additionalNetworks` is typed
 * `{ [key: string]: ImageJobNetworkParams }` and its doc comment reads "Use the
 * AIR of the network as the key"; `WorkflowCost.fees` is likewise keyed by
 * resource AIR (both in the generated `@civitai/client` types). A scan over
 * `Object.values` alone therefore misses the single most likely real-world
 * placement of an AIR in a submitted step, and returns a confident
 * `noResourceReference` for `{ additionalNetworks: { 'urn:air:…': {…} } }` — a
 * LoRA reaching the entitlement belt through the gate's blind spot.
 *
 * 🔴 "ANYWHERE" IS SCOPED TO JSON-SHAPED INPUT, AND THE ONE EXCEPTION IS
 * `toJSON`-BEARING INSTANCES. What makes the totality claim hold in general is
 * that `Object.entries` visibility ≈ `JSON.stringify` visibility: `Map`, `Set`
 * and non-enumerable own properties are invisible to BOTH, so an AIR hidden in
 * one cannot reach the orchestrator either. A class with a `toJSON` breaks that
 * equivalence — measured: `containsAirReference(new URL('https://x/urn:air:…'))`
 * returns FALSE while `JSON.stringify` of it CONTAINS the AIR.
 *
 * NOT reachable today: `parseStepParams` runs the entry's `.strict()`
 * `paramSchema` before `buildStep`, and no registered entry admits a class
 * instance. It becomes reachable the first time an entry declares a
 * `z.unknown()` / `z.any()` / `z.custom()` param — superjson DOES reconstruct a
 * `URL` across the tRPC boundary. An entry doing that owes either a stricter
 * schema or a pre-scan `JSON.parse(JSON.stringify(input))` normalisation.
 */
export function containsAirReference(value: unknown, depth = 0): boolean {
  if (depth > AIR_SCAN_MAX_DEPTH) return true;
  if (typeof value === 'string') return value.toLowerCase().includes(AIR_URN_PREFIX);
  if (Array.isArray(value)) return value.some((v) => containsAirReference(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, v]) => containsAirReference(key, depth + 1) || containsAirReference(v, depth + 1)
    );
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
 * rule gives false comfort, so the rule here is the narrower one: free-text
 * OUTPUT.
 *
 * 🔴 THAT RULE IS NARROWER, NOT COMPLETE — an earlier revision called it
 * "complete" and review disproved it. Uncovered types whose OUTPUT carries free
 * text include `imageResourceTraining` (`sampleImagesPrompts[]` — echoed user
 * prompts, the SAME rationale used to list `echo` below, which is a live
 * inconsistency), `modelParseMetadata.metadata`
 * (a `__metadata__` header out of a user-uploaded safetensors), the
 * `modelClamScan` / `modelPickleScan` `output` + `skipReason` fields, and
 * `qwenImageBench.errors`. They are NOT listed because whether each is really
 * a free-text surface a block could publish is a judgment a domain owner should
 * make, not one to settle silently in this commit. Listing the candidates is
 * the honest middle: the next person to add a text-producing entry starts from
 * a named set rather than from "complete".
 *
 * 🔴 `mediaRating.blockedReason` USED TO BE ON THAT LIST AND WAS REMOVED, not
 * overlooked. `blockedReason` is platform-AUTHORED moderation copy, not
 * external free text, and it is now recorded per-row in
 * `platformDiagnosticFields` (`./request-time-policy`) across the 24 `$type`s
 * whose output carries it — a `Blob` field, so it reaches far more rows than
 * `mediaRating` alone. `mediaRating` remains `undecidedNeedsDomainOwner` on its
 * own merits (`labels[]`, `ageClassification.error`), which is why deleting it
 * from this list licenses nothing.
 *
 * An unlisted text-IN type registering as `'none'` skips an
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
  // Echoes caller-supplied `message` back out. 🔴 NOTE THE RATIONALE DOES NOT
  // FIT THIS ONE CLEANLY, and pretending otherwise is how `textToSpeech` got in:
  // for `echo` the output IS the input, so `'promptAudit'` would in fact cover
  // the whole surface. It is constrained to `'textOutput'` as the conservative
  // choice — that is a real cost (an `echo` entry cannot register until
  // `'textOutput'` is implemented) accepted deliberately, because relaxing it
  // means asserting that auditing the input suffices for a text-emitting step,
  // which is the subsumption judgment this map declines to make anywhere else.
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
    // 🔴 NO `as` CAST HERE — it was unnecessary, and removing dead type
    // assertions off a spend-path allowlist is worth doing. But BE PRECISE
    // ABOUT WHAT THAT BOUGHT, because the obvious reading is wrong and was
    // measured: removing the cast does NOT restore element-type checking on
    // this transform. `Object.assign`'s intersection result swallows it either
    // way — changing this `.map` to produce `readonly string[]` instead of
    // `readonly StepModerationPosture[]` compiles clean WITH the cast and
    // WITHOUT it, verified both ways.
    //
    // So the `satisfies` above protects the LITERAL, and nothing at compile
    // time protects the transform between that literal and the exported
    // allowlist. The RUNTIME pair in the tests — "every listed posture is a
    // DECLARED posture" and "every entry is single-valued" — is the guard.
    //
    // 🔴 BE EXACT ABOUT WHAT IT COVERS; an earlier revision of this very
    // comment said those tests "turn 4 red on exactly that mutation", naming
    // the type-widening one, and that was FALSE. Measured, three ways:
    //
    //   `[...postures] as string[]`      → 0 red  (a PURE TYPE widening; the
    //                                      runtime values are unchanged, so
    //                                      there is nothing for a runtime test
    //                                      to see, and nothing to catch)
    //   `[...postures, 'nope']`          → 2 red
    //   `postures.map(x => x.toUpperCase())` → 4 red
    //
    // i.e. a transform that changes VALUES is caught; one that only widens the
    // TYPE is caught by nothing and needs nothing. That is a narrower claim
    // than the one it replaces, and it is the true one.
    Object.fromEntries(
      Object.entries(ACCEPTABLE_POSTURES_BY_TYPE).map(([type, postures]) => [
        type,
        Object.freeze([...postures]),
      ])
    )
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
  /**
   * 🔴 REQUIRED. See `StepModerationPosture`.
   *
   * 🔴 IT IS ALSO THE OUTPUT-SHAPE DISCRIMINANT. `BlockStep` intersects this
   * base with the `StepOutputSurface` union below, which narrows this field to
   * `'textOutput'` on the text member and to `'none' | 'promptAudit'` on the
   * media member — so declaring the posture is the same act as declaring which
   * extractor the entry supplies. See `stepOutputShape`.
   */
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
   * Returns a bounded id from `variants` — never a client-raw string.
   *
   * 🔴 WHAT ACTUALLY DERIVES FROM IT — stated exactly, because the previous
   * wording ("the price/budget, the built step, and the display estimate MUST
   * all agree on this one value, so they all derive it here") over-claimed and a
   * reader who trusted it would have looked for a bound that was not there. Only
   * the PRICE/BUDGET is computed FROM this value (`priceForVariant(variant)`);
   * the settle `engine` and the usage audit row RECORD it. The BUILT STEP
   * (`buildStep(params)`) and the DISPLAY ESTIMATE (`estimateBuzz(params)`) are
   * computed from the PARAMS and never receive the variant at all — they are
   * only required to be CONSISTENT with it, which registry load checks for the
   * canonical params of each variant (clause 5, and the price-equals-estimate
   * clause) and nothing re-checks at request time.
   *
   * What estimate and submit DO share is the BOUND: `estimateStepBuzz` and
   * `planStepSpend` both resolve through `resolveStepVariant` before dispatching
   * to a billing-mode handler, so an out-of-set resolution fails identically on
   * both. Before that they did not, and an entry whose variant is its model
   * would have answered an out-of-set model with HTTP 200 and
   * `cost: { total: undefined }` on estimate while the submit threw.
   *
   * 🔴 CALL IT THROUGH `resolveStepVariant`, NEVER DIRECTLY. "Returns a bounded
   * id" is a promise the ENTRY makes about a function that receives untrusted
   * params; the wrapper is what checks it. Clause 5 below only checks the
   * canonical params, i.e. one author-chosen input per variant. The return type
   * of the wrapper (`BoundedStepVariant`) is what carries that proof into every
   * downstream consumer.
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
   *
   * REQUIRED for BOTH output shapes: it is the probe input for clause 8 (media)
   * AND for clause 8a (text).
   */
  canonicalOutputFor(variant: string): unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE OUTPUT SURFACE — MEDIA **XOR** TEXT, discriminated on `moderationPosture`.
//
// 🔴 THIS IS WHERE "a text-posture entry cannot smuggle prose through
// `media.url`" IS MADE STRUCTURAL RATHER THAN GUARDED. `extractOutput?: never`
// on the text member means a `'textOutput'` entry cannot DECLARE a media
// extractor at all — there is no field to put a fabricated url in, so there is
// nothing for a runtime guard to catch. See `stepOutputShape` for the defect
// this replaces (an honest text entry could not register; the dishonest
// media-shaped one could, and its prose reached `snapshot.imageUrls` /
// `AppWorkflow.images[].url` without ever passing the scan).
//
// 🔴 WHY `?: never` AND NOT AN OMITTED FIELD. Omitting `extractOutput` from the
// text member would make an entry that declares one merely have an EXCESS
// property — which TypeScript only rejects for a fresh object literal, and
// silently allows through any variable, spread or `Partial<…>` widening. `never`
// makes the field unassignable on every path (`satisfies`, a typed const, a
// spread through a helper), which is the difference between a lint and a rule.
//
// 🔴 THE LOAD-TIME CLAUSES ARE NOT REDUNDANT WITH THIS. The registry is reached
// through `AnyBlockStep` and `as` casts in several places (and a future entry
// could be constructed dynamically), so clauses 8/8a re-assert the same XOR at
// runtime, off the same `stepOutputShape` predicate. Type + load + read path,
// one rule.
// ─────────────────────────────────────────────────────────────────────────────

/** A step whose result is MEDIA — the pre-existing shape, unchanged. */
type MediaOutputSurface = {
  /** Narrowed from `BlockStepBase`: every posture whose shape is `'media'`. */
  moderationPosture: Exclude<StepModerationPosture, 'textOutput'>;
  /**
   * 🔴 REQUIRED for a media entry. PURE extractor: the orchestrator's completed
   * step object → the output media the caller gets back. Called by BOTH
   * `snapshotFromWorkflow` (`imageUrls`) and `projectAppWorkflow` (`images`), so
   * one declaration surfaces the result on both read surfaces.
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
   * FORBIDDEN. A posture that never scans generated text must not carry an
   * extractor that reads as generated-text coverage and is never called
   * (clause 1c's reverse direction, at the type level).
   */
  extractText?: never;
};

/** A step whose result is generated FREE TEXT, published only through the scan. */
type TextOutputSurface = {
  /** Narrowed from `BlockStepBase`: the only posture whose shape is `'text'`. */
  moderationPosture: 'textOutput';
  /**
   * 🔴 REQUIRED for a text entry. PURE: the orchestrator's completed step → the
   * generated FREE TEXT that must be scanned before it can reach the block.
   *
   * The OUTPUT-side twin of `auditableText`, and a declared field for the same
   * reason `extractOutput` is: the output KEY is step-type-specific, so the
   * entry NAMES its generated text rather than the registry sniffing for
   * string-valued fields — which would scan a blob url and miss
   * `choices[].message.content`.
   *
   * 🔴 AND IT IS THE OTHER HALF OF THE WITHHOLDING CONTRACT. Whatever this
   * returns is what the scan sees AND what a release publishes: the read path
   * emits exactly these strings, never `step.output` directly. So a piece of
   * generated text this function does not return is a piece of text that is
   * never scanned AND never published — the two properties move together by
   * construction, which is what makes an under-inclusive extractor a missing
   * feature rather than a silent moderation hole.
   *
   * MUST return non-empty strings for `canonicalOutputFor(variant)` — enforced
   * at load (clause 8a): a field satisfiable by `() => []` is a declared posture
   * that scans nothing, publishes nothing, and reports success.
   */
  extractText(step: unknown): string[];
  /**
   * 🔴 FORBIDDEN, AND THIS IS THE ANTI-SMUGGLING CONTROL. `StepOutputMedia.url`
   * is a bare `string` that is never URL-validated and flows straight to
   * `snapshot.imageUrls` and `AppWorkflow.images[].url` WITHOUT passing through
   * `attachModeratedStepTextOutputs`. If a text entry could declare a media
   * extractor, `extractOutput: () => [{ url: theModelsReply, … }]` would publish
   * unscanned generated text through the media channel while every moderation
   * gate stayed green. `never` is what makes that unwritable.
   */
  extractOutput?: never;
};

/**
 * The output surface a registered step declares. See the block comment above —
 * MEDIA XOR TEXT, discriminated on `moderationPosture`.
 */
type StepOutputSurface = MediaOutputSurface | TextOutputSurface;

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
 *
 * 🔴 INTERSECTED WITH `StepOutputSurface`, a SECOND discriminated union — on
 * `moderationPosture` — that makes the output shape MEDIA XOR TEXT at compile
 * time. The two axes are independent (any billing mode may publish either
 * shape), so an intersection is the honest encoding; spelling out all six
 * combinations by hand would be the same type with six places to forget.
 */
export type BlockStep<P = unknown> = (
  | PrepaidFixedStep<P>
  | TimeBoundedStep<P>
  | TokenMeteredStep<P>
) &
  StepOutputSurface;

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

/**
 * Everything a billing-mode handler is allowed to see.
 *
 * 🔴 THE VARIANT IS PASSED IN, ALREADY BOUNDED. The previous shape handed a
 * handler `(step, params)` and asked, in a comment, that it route its own
 * resolution through `resolveStepVariant`. A comment is not a choke point — a
 * future `timeBounded` handler written as
 * `budgetForVariant(entry.resolveVariant(params))` would have reopened the
 * budget-gate fail-open verbatim while reading as ordinary code, because nothing
 * would have been there to stop it. Now the bound happens ONCE in the dispatcher
 * below, for every mode, before any handler runs.
 *
 * 🔴 BE EXACT ABOUT THE STRENGTH OF THAT. A handler still receives `step` and
 * `params`, so it CAN call `step.resolveVariant` — no type prevents it. What
 * changed is that doing so is now visibly a second, unbounded re-derivation of a
 * value the handler was already handed, rather than the only way to obtain one.
 * The type system's part is narrower and exact: a handler cannot pass its own
 * re-derivation to anything that takes a `BoundedStepVariant` without an explicit
 * cast.
 */
type StepSpendContext = {
  step: AnyBlockStep;
  /** The entry's own `.strict()`-parsed params. Still untrusted CONTENT. */
  params: unknown;
  /** Proven a member of `step.variants` — see `resolveStepVariant`. */
  variant: BoundedStepVariant;
};

type BillingModeHandler = {
  estimateBuzz(ctx: StepSpendContext): number;
  planSpend(ctx: StepSpendContext): StepSpendPlan;
};

/**
 * A variant string PROVEN to be a member of its entry's declared `variants`.
 *
 * 🔴 THE BRAND IS THE ENFORCEMENT. `resolveStepVariant` is the only function
 * that produces one, so every consumer that declares this type — the
 * billing-mode handlers, and through them the price lookup — cannot be handed a
 * raw `step.resolveVariant(params)` without an explicit cast that a reviewer
 * will see. The alternative was a prose instruction to use the wrapper, which is
 * exactly the class of guarantee this file has repeatedly failed to keep.
 *
 * It is a `string` at runtime; the brand exists only in the type system.
 */
export type BoundedStepVariant = string & { readonly __boundedStepVariant: 'bounded' };

/**
 * `step.resolveVariant(params)`, BOUNDED to the entry's declared `variants`.
 *
 * 🔴 WHY A WRAPPER RATHER THAN THE RAW CALL. `resolveVariant` is documented as
 * returning "a bounded id from `variants` — never a client-raw string", and
 * until now that was a PROSE promise the entry made: nothing checked it, and
 * clause 5 only checks it for `canonicalParamsFor(v)` — one fixed input per
 * variant, chosen by the entry author. At REQUEST time the argument is the
 * untrusted iframe's `.strict()`-parsed params, and the return value is fed
 * straight into `priceForVariant` on the money path.
 *
 * 🔴 THE FAILURE THAT MOTIVATES IT, MEASURED RATHER THAN REASONED. With an
 * entry whose `resolveVariant` returns a param (`(p) => p.model`) and whose
 * `priceForVariant` is a record lookup, an out-of-set value made
 * `priceForVariant` return `undefined` → `planStepSpend().reserveBuzz`
 * `undefined` → the router's `Math.ceil(...)` `NaN` → and `NaN > buzzBudget`
 * evaluates **false**, so the per-call budget gate PASSES. Executed on
 * unmodified `main` before this wrapper existed; the numbers are from that run,
 * not from reading the code.
 *
 * 🔴 BE EXACT ABOUT REACHABILITY — this is a LATENT fail-open, not a live one.
 * The sole registered entry today (`convert-image`) returns a CONSTANT
 * (`() => 'default'`), so no params can steer it and the shape above cannot be
 * reached by any shipped code path. It becomes reachable the moment an entry
 * derives its variant FROM params — which is exactly what a model-allowlisted
 * entry wants to do, since per-model pricing has to key off the variant. This
 * wrapper is therefore a prerequisite for that shape, not a fix for a live bug,
 * and the test that pins it says so.
 *
 * 🔴 AND BE EXACT ABOUT WHAT IT BINDS. It proves the resolved value is a MEMBER
 * of `step.variants`. It does NOT prove `variants` itself is a sensible set —
 * that stays what it always was, a reviewed declaration in a code-reviewed
 * trust root. What it buys is that everything downstream (the price lookup, the
 * settle `engine`, the audit row) receives a value from a fixed, reviewed,
 * enumerable set rather than whatever the entry chose to return.
 *
 * Throws a plain `Error` (not a TRPC caller error) on purpose: the params were
 * already accepted by the entry's own `.strict()` schema, so a resolution
 * outside the declared set is a REGISTRY-ENTRY bug, not a caller mistake, and
 * it should surface as a 500 the way any other broken invariant does. A plain
 * `Error` also keeps this module import-light, which `workflow.schema` depends
 * on.
 *
 * 🔴 THE MESSAGE IS ECHOED TO THE UNTRUSTED IFRAME. `trpc.ts`'s `errorFormatter`
 * is pass-through (`({ shape }) => shape`), and `getTRPCErrorFromUnknown`
 * preserves an unrecognized throw's `message`, so everything below reaches the
 * block's own JS — INCLUDING `step.variants.join(', ')`, i.e. the entry's ENTIRE
 * declared allowlist. For `convert-image` that is the single word `default` and
 * discloses nothing. For the model-allowlisted entry this is groundwork for, it
 * would be the full model list, which may name a model that is not public yet.
 * 🔴 So an entry whose `variants` are not all public information must choose
 * this message deliberately — either by keeping unreleased ids out of
 * `variants`, or by making the resolution unreachable (a `z.enum` paramSchema
 * over the same set turns an out-of-set value into a BAD_REQUEST at parse,
 * before this guard is ever reached).
 */
export function resolveStepVariant(step: AnyBlockStep, params: unknown): BoundedStepVariant {
  // Deliberately typed `unknown`: `resolveVariant`'s declared `string` return is
  // the entry's CLAIM, and this function exists precisely because the entry's
  // claims are not checked anywhere else.
  const variant: unknown = step.resolveVariant(params);
  // 🔴 THE TYPE CHECK IS NOT REDUNDANT WITH THE MEMBERSHIP CHECK BELOW.
  // `Array.prototype.includes` uses SameValueZero, under which `NaN` matches
  // `NaN` — so an entry declaring `variants: [NaN as any]` with
  // `resolveVariant: () => NaN` would PASS `includes` and hand `NaN` to
  // `priceForVariant`, reopening the exact `undefined` → `Math.ceil` → `NaN` →
  // `NaN > buzzBudget === false` budget-gate bypass this wrapper exists to
  // close. TypeScript rejects that entry without the cast, so it is latent, not
  // live — the same posture as the fail-open itself.
  if (typeof variant !== 'string') {
    throw new Error(
      `block step '${step.id}': resolveVariant() returned a non-string ` +
        `(${typeof variant}: ${String(variant)}) — the price lookup keys off this value, and a ` +
        'non-string resolution is a money-path input nobody reviewed'
    );
  }
  if (!step.variants.includes(variant)) {
    throw new Error(
      `block step '${step.id}': resolveVariant() returned '${variant}', which is not one of the ` +
        `declared variants [${step.variants.join(', ')}] — the price lookup, the settle record ` +
        'and the audit row all key off this value, so an unbounded one is a money-path input ' +
        'nobody reviewed'
    );
  }
  return variant as BoundedStepVariant;
}

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
    // The display estimate is computed from the PARAMS — the variant is not an
    // input to it, and this handler deliberately does not destructure one. What
    // the bound buys this path is that `estimateStepBuzz` already threw on an
    // out-of-set resolution before reaching here, so estimate can no longer
    // answer 200 where submit throws.
    estimateBuzz: ({ step, params }) => step.estimateBuzz(params),
    planSpend: ({ step, variant }) => {
      const entry = step as PrepaidFixedStep<unknown>;
      return {
        // 🔴 A `BoundedStepVariant`, resolved ONCE by the dispatcher. The price
        // lookup is the money-path consumer that made an unbounded resolution a
        // budget-gate bypass (see `resolveStepVariant`'s header for the measured
        // sequence), so it takes the value it was handed — substituting a fresh
        // `entry.resolveVariant(params)` here is what the bound exists to stop
        // being the normal way to write this line.
        reserveBuzz: entry.priceForVariant(variant),
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

/**
 * The display estimate for a step, dispatched on its declared billing mode.
 *
 * Resolves the variant through `resolveStepVariant` before dispatching — see
 * `planStepSpend` below for why the resolution lives in the dispatcher, and note
 * that this is what makes an out-of-set resolution fail IDENTICALLY on estimate
 * and on submit.
 */
export function estimateStepBuzz(
  step: AnyBlockStep,
  params: unknown,
  variant: BoundedStepVariant = resolveStepVariant(step, params)
): number {
  return billingModeHandlers[step.billingMode].estimateBuzz({ step, params, variant });
}

/**
 * The spend plan for a step submit, dispatched on its declared billing mode.
 *
 * 🔴 THE VARIANT IS RESOLVED HERE, NOT IN A HANDLER. Every billing mode keys its
 * price/budget off a variant, so the bound belongs at the one place all modes
 * pass through rather than being re-applied (or forgotten) per handler. `variant`
 * is a parameter so a caller that has ALREADY resolved it — `submitStepWorkflow`
 * does, once, before any reservation — threads that single derivation down
 * instead of recomputing it; omitting it resolves here. Either way the value is
 * a `BoundedStepVariant`, which only `resolveStepVariant` can produce.
 */
export function planStepSpend(
  step: AnyBlockStep,
  params: unknown,
  variant: BoundedStepVariant = resolveStepVariant(step, params)
): StepSpendPlan {
  return billingModeHandlers[step.billingMode].planSpend({ step, params, variant });
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
  // 'promptAudit' runs `auditPromptServer` in the SUBMIT phase — the SAME audit
  // `textToImage` and `customComfy` run, host-side and before submission.
  // 'textOutput' runs an xGuardModeration text scan in the OUTPUT phase, at the
  // read boundary, and withholds on a policy hit. It ALSO withholds on most —
  // 🔴 not all — scanner failures: scan threw or the hard deadline fired, no
  // output (submit failed, or the workflow was still running when the scan wait
  // elapsed), content over the scanned-character cap, and a requested label
  // absent from `results[]`. NOT on a per-label `error`, which currently
  // RELEASES; `./text-output-moderation` documents that gap at the verdict
  // function. Do not restate this as "any scanner failure" — three separate
  // comments said exactly that, it was false in all three, and a safety claim
  // stronger than the code is what a maintainer deletes a guard on the strength
  // of. Re-derive from `decideTextOutputVerdict` before trusting this summary in
  // EITHER direction.
  // Both handlers live in `./moderation`, which asserts at ITS load that each
  // posture has a handler in exactly the phases `posturePhaseRequirements` names.
  return posture === 'none' || posture === 'promptAudit' || posture === 'textOutput';
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
// 🔴 FROZEN, FOR THE SAME REASON `STEP_TYPE_ACCEPTABLE_POSTURES` IS — and BE
// PRECISE ABOUT WHAT THAT BUYS, because it is less than the freeze above buys.
// Neither post-load mutation direction is a HOLE today: adding an entry here
// after load does not make it submittable (`REGISTERED_STEP_IDS` was already
// snapshotted into `blockStepBodySchema`'s enum, so the id is rejected at the
// union), and flipping a live entry's `moderationPosture` to `'none'` fails
// CLOSED at the read path (a text entry has no `extractOutput`, so the media
// branch yields nothing and the `'none'` dispatch releases an empty list). So
// this is CONSISTENCY on the discriminant all three enforcement layers read,
// not a closed vulnerability — recorded as such rather than dressed up.
//
// SHALLOW ON PURPOSE, BOTH LEVELS. Freezing the container blocks entry
// addition/replacement; freezing each entry blocks `entry.moderationPosture =
// …`, which is the assignment that would matter. It deliberately does NOT
// recurse into an entry's nested values — those include zod schemas, which
// populate internal caches lazily and must stay mutable. A deep freeze here
// would trade a consistency nicety for a runtime failure mode.
// 🔴 ORDER IS OBSERVABLE: `REGISTERED_STEP_IDS` is `Object.keys(...)`, so a new
// entry goes at the END. Prepending would renumber the wire enum's iteration
// order for no reason and shift `REGISTERED_STEP_IDS[0]`, which existing tests
// use as "a valid id".
const stepRegistry = Object.freeze({
  'convert-image': Object.freeze(convertImageStep),
  'chat-completion': Object.freeze(chatCompletionStep),
});

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

  // (1c) POSTURE ↔ `extractText` AGREEMENT, both directions — the OUTPUT-side
  // twin of 1a, and the weights are the MIRROR IMAGE of 1a's, which is worth
  // stating because the symmetry is misleading.
  //
  // Forward (posture requires the field, entry omits it) — 🔴 A GENUINE CONTROL
  // here, unlike 1a's forward direction. 1a could delegate to clause 5a because
  // 5a calls `step.auditableText!(...)` unconditionally for a `'promptAudit'`
  // entry and dies on the missing function. Clause 8a below is written to the
  // same shape, so this branch is likewise the NAMED error rather than the only
  // rejection — but the read path is what makes it matter: a `'textOutput'`
  // entry with no extractor produces NO text, so the read path would publish
  // nothing and scan nothing, and nothing downstream would ever complain. The
  // failure would be a silently mute capability, not an exception.
  //
  // Reverse (field declared under a posture that never scans it) — 🔴 A GENUINE
  // CONTROL, same as 1a's reverse. The read path only calls `extractText` for a
  // `'textOutput'` entry, so a `'none'` entry declaring one has an extractor
  // that reads as generated-text coverage and is never called.
  if (postureRequiresTextExtraction(step.moderationPosture)) {
    if (typeof step.extractText !== 'function') {
      throw new Error(
        `${where}: moderationPosture '${step.moderationPosture}' requires an extractText() ` +
          'declaration naming the generated text to scan — a posture that can be satisfied by ' +
          'scanning nothing is not a posture'
      );
    }
  } else if (step.extractText !== undefined) {
    throw new Error(
      `${where}: declares extractText() but moderationPosture '${step.moderationPosture}' ` +
        'never scans it — the generated text would reach the block unscanned'
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
  // `buildStep(...).$type === orchestratorType` per variant, TOGETHER WITH the
  // request-time re-assert of the same equality in the router's step submit
  // path. Neither is sufficient alone; if either is weakened, this clause
  // degrades to a speed bump.
  //
  // 🔴 BE PRECISE ABOUT WHICH ONE BUYS WHAT — an earlier revision of this
  // comment said "1b + 7a together tie the posture to the type actually
  // submitted" and that was ALSO an overclaim, in the same shape as the one
  // above it: 7a probes CANONICAL params only, so a `buildStep` that switches
  // its `$type` ON PARAMS satisfies 7a at load and diverges at request time.
  // Review demonstrated exactly that by execution. The load-time pair binds
  // the DECLARED shape; only the router's re-assert binds the SUBMITTED one.
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
    // 🔴 BUILT FOR EVERY ENTRY, not just `'none'`-policy ones as before, because
    // clause 7a below needs it unconditionally. That widens the blast radius of
    // a `buildStep` that throws or returns a non-object — it now crashes module
    // load for ANY entry — so the shape is checked here, with a clause name
    // attached, rather than surfacing as a bare `TypeError` on `built.$type`.
    const built = step.buildStep(parsed.data);
    if (built === null || typeof built !== 'object') {
      throw new Error(
        `${vWhere}: buildStep() must return an orchestrator step template, got ${typeof built}`
      );
    }

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
    // params, so a `buildStep` that switches `$type` ON PARAMS satisfies this
    // clause and still diverges at request time. It is a floor, not a proof.
    // That gap IS closed — by the request-time re-assert of the same equality
    // in `blocks.router.ts`'s step submit path, beside the resource-policy
    // re-assert that set the precedent, and covered by a router test using a
    // params-dependent fixture that passes THIS clause. Do not read the limit
    // above as an open hole; read it as the reason the router clause exists.
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

    // (8) OUTPUT EXTRACTION must actually surface something — 🔴 POSTURE-GATED,
    // on the SHAPE the entry declares (`stepOutputShape`), not unconditionally.
    //
    // 🔴 WHAT THE GATE FIXES. This clause used to demand ≥1 media item with a
    // non-empty `url` from EVERY entry, with no posture gate — in deliberate
    // contrast to clause 8a below, which was already gated. But every `$type`
    // that `ACCEPTABLE_POSTURES_BY_TYPE` licenses for `'textOutput'` is
    // TEXT-producing and none is media-producing, so an honest
    // `chatCompletion` + `'textOutput'` entry could NOT register: it had no
    // media to return. The workaround an author reaches for next — prose in a
    // fabricated `media.url` — DID register, and shipped that prose unscanned
    // (`snapshot.imageUrls` / `AppWorkflow.images[].url` never pass through
    // `attachModeratedStepTextOutputs`). Both directions were proven by
    // execution in review. So the requirement is now the entry's declared
    // SHAPE, and the smuggling vector is closed at the type level as well
    // (`TextOutputSurface.extractOutput?: never`).
    const sampleStep = step.canonicalOutputFor(variant);
    if (postureProducesMedia(step.moderationPosture)) {
      // 8-i. A media entry MUST declare the extractor. Enforced at runtime as
      // well as in the type, because the registry is reached through
      // `AnyBlockStep` and `as` casts — without this the failure would be a bare
      // `TypeError: step.extractOutput is not a function` out of module load.
      if (typeof step.extractOutput !== 'function') {
        throw new Error(
          `${vWhere}: moderationPosture '${step.moderationPosture}' publishes MEDIA and requires ` +
            'an extractOutput() declaration — without it the step is charged for, reaches ' +
            'succeeded, and its result is unreachable on both read surfaces'
        );
      }
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
    } else if (step.extractOutput !== undefined) {
      // 8-ii. 🔴 THE ANTI-SMUGGLING CLAUSE, and the runtime half of
      // `TextOutputSurface.extractOutput?: never`. A text-posture entry that
      // carries a media extractor has a channel to the block that the scan does
      // NOT stand in front of: `StepOutputMedia.url` is a bare string, never
      // URL-validated, and it reaches `snapshot.imageUrls` and
      // `AppWorkflow.images[].url` directly. Rejecting the DECLARATION is what
      // makes the channel non-existent rather than merely policed — there is no
      // "but only if the url looks like prose" heuristic here to get wrong.
      throw new Error(
        `${vWhere}: declares extractOutput() but moderationPosture ` +
          `'${step.moderationPosture}' publishes TEXT — a media extractor on a text step is an ` +
          'unscanned channel to the block (media urls bypass the output scan entirely), so the ' +
          'declaration is rejected rather than policed'
      );
    }

    // (8a) THE NON-VACUITY PROBE for `extractText` — clause 8's twin on the
    // generated-TEXT axis, and clause 5a's twin one phase later.
    //
    // 🔴 WHAT IT BUYS, AND WHAT IT DOES NOT. The read path publishes exactly
    // what this returns, so an extractor that returns `[]` is not a moderation
    // hole — nothing unscanned escapes. It is an INERT CAPABILITY: a step that
    // charges Buzz, reaches `succeeded`, declares a text-output posture, and can
    // never return a word to the caller, with every other invariant green. Same
    // failure this registry already shipped once on the MEDIA axis, which is why
    // clause 8 exists; this is that clause on the axis clause 8 cannot see.
    //
    // 🔴 HONEST LIMIT, identical in shape to the one the type-contract file
    // records for clause 8: `extractText` and `canonicalOutputFor` are authored
    // by the same person in the same file, so this is a SELF-CONSISTENT PAIR,
    // not a contract check against the orchestrator. It catches an extractor
    // that surfaces nothing for its own sample; it cannot catch an extractor and
    // a sample that agree with each other while both being wrong about the real
    // response shape. The mitigation is the same one `convert-image` uses — a
    // generated-type assertion in `./type-contract` — and the entry that
    // registers the first `'textOutput'` step owes one.
    if (postureRequiresTextExtraction(step.moderationPosture)) {
      // 1c proved this is a function; the non-null assertion is that guard's
      // result, not an assumption.
      const texts = step.extractText!(sampleStep);
      if (!Array.isArray(texts) || texts.length === 0) {
        throw new Error(
          `${vWhere}: extractText() returned no text for canonicalOutputFor() — the step's ` +
            'generated text would be scanned by nothing AND published to nobody'
        );
      }
      for (const text of texts) {
        if (typeof text !== 'string' || text.trim().length === 0) {
          throw new Error(
            `${vWhere}: extractText() returned a non-string or empty entry — the scan would be ` +
              'handed a value it cannot read while the entry reports coverage'
          );
        }
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
