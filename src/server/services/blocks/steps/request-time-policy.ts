import type { StepBillingMode, StepModerationPosture } from './index';
import { containsAirReference } from './index';

// ─────────────────────────────────────────────────────────────────────────────
// REQUEST-TIME ENFORCEMENT CORE for app-composed orchestrator steps.
//
// WHAT THIS IS. The step registry (`./index`) makes three decisions —
// MODERATION POSTURE, RESOURCE/ENTITLEMENT POLICY and BILLING MODE — by reading
// a DECLARATION off a registered entry, and it makes them at REGISTRATION time
// (module load, a build error). The App Blocks → orchestrator-types pivot
// removes registration: an app composes real orchestrator workflow steps and the
// host submits them, so there is no entry to declare anything.
//
// 🔴 THE THREE GUARDS DO NOT SURVIVE THAT MOVE ON THEIR OWN. Each one is keyed
// on a field (`step.moderationPosture`, `step.resourcePolicy`,
// `step.billingMode`) that only exists because an entry was written and
// reviewed. With arbitrary steps the ONLY trustworthy input is the `$type` the
// app submitted and the `input` object it built. So this module re-homes all
// three onto that pair, and every one of them FAILS CLOSED.
//
// 🔴 IT IS NOT THE WIRE CONTRACT AND IT DOES NOT REPLACE THE REGISTRY. Nothing
// here widens what may be submitted today; `blockStepBodySchema`'s `step` enum
// is still derived from the registry keys and is still the gate. This module is
// the enforcement core the widening will need, landed AHEAD of it and wired into
// the registry path (see `assertRegistryEntryAgreesWithPolicy`) so it is
// exercised rather than dead.
//
// ─────────────────────────────────────────────────────────────────────────────
// PROVENANCE OF THE TABLE BELOW — READ THIS BEFORE EDITING A ROW.
//
// Every `textFields` path was ENUMERATED from the generated `@civitai/client`
// types (`dist/generated/types.gen.d.ts`, v0.2.0-beta.83) by walking each
// `$type`'s `<Name>Output` transitively and collecting every string-valued
// field. It was NOT derived from `src/**` usage — that enumerates what is
// CALLED, not what EXISTS, and the registry's own Tranche-1 note records the
// same correction.
//
// 🔴 TWO MEASURED CORRECTIONS THAT THE OBVIOUS METHOD GETS WRONG, recorded
// because both produce a CONFIDENT WRONG ANSWER rather than an error:
//
//   1. A NAME-BASED filter silently drops real text. Filtering "structural"
//      string fields by name pattern dropped `TranscriptionOutput.text` — "The
//      full transcribed text" — because `text` ends in `ext`. A text surface
//      filtered out reads as "this type produces no text", which is the
//      fail-OPEN direction. The table is therefore built from the enumerated
//      field list plus its generated DOC COMMENT, never from a name heuristic.
//
//   2. `$type` → type-name casing is NOT a plain capitalisation.
//      `model3DPreview` resolves to `Model3dPreviewOutput` (lowercase `d`), so a
//      naive `$type[0].toUpperCase()` lookup finds NOTHING and the type silently
//      drops out of the population entirely — again fail-open. Resolution is
//      case-insensitive.
//
// 43 `$type` values exist in the generated types; all 43 are covered below.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What FREE TEXT a `$type`'s output carries, and therefore what the host owes
 * before that output may reach an app.
 *
 * 🔴 THE DISTINCTION THAT MATTERS IS *NOT* "has a string field". Almost every
 * type has one — ids, blob urls, expiry timestamps, format enums, hashes.
 * `convertImage` has two (`blob.previewUrl`, `blob.previewUrlExpiresAt`) and
 * produces no free text at all. Classifying on "has a string" would put every
 * type behind the text scan, which is not a stricter policy — it is a policy
 * nobody can ship, and it would be relaxed wholesale the first time it bit.
 */
export type StepTextSurface =
  /** No free text in the output. Structural strings (urls, ids, hashes) only. */
  | 'none'
  /**
   * MODEL-GENERATED free text. The surface the prompt audit cannot cover,
   * because the text does not exist when the prompt audit runs. Requires the
   * `'textOutput'` posture and its scan.
   */
  | 'generatedText'
  /**
   * Caller-supplied text ECHOED back out. Distinguished from `generatedText`
   * because the whole surface is auditable at INPUT — but it is deliberately
   * NOT given a weaker treatment here (see `postureForTextSurface`).
   */
  | 'echoedInput'
  /**
   * 🔴 TEXT LIFTED OUT OF AN UNTRUSTED ARTIFACT, or a tool's raw diagnostic
   * output. NOT model-generated and NOT caller-echoed — a third category the
   * registry's two-posture model does not have a slot for.
   *
   * Examples in the table: the `__metadata__` JSON header of a user-uploaded
   * safetensors (`modelParseMetadata`), raw ClamAV / picklescan console output
   * and the Python import paths they discovered (`modelClamScan`,
   * `modelPickleScan`).
   *
   * 🔴 THIS VALUE IS A REFUSAL, NOT A CLASSIFICATION. Whether such a surface is
   * something an App Block may publish is a policy question with a real answer
   * either way, and it is a DOMAIN OWNER's to make — so the type is NOT
   * submittable while it holds this value (`postureForTextSurface` returns no
   * posture). That is the fail-closed direction and it is deliberate: the
   * alternative is to guess, and a guess here either blocks a legitimate
   * capability or publishes an attacker-controlled string.
   */
  | 'undecidedNeedsDomainOwner';

/** The policy facts derived for one orchestrator `$type`. */
export type StepTypePolicy = {
  /** See `StepTextSurface`. */
  textSurface: StepTextSurface;
  /**
   * The generated-type field paths that carry the text, relative to the step's
   * `output`. PROVENANCE for review — this is what a reviewer checks a
   * classification against, and what a regenerated client is diffed against.
   * Empty iff `textSurface` is `'none'`.
   */
  textFields: readonly string[];
  /**
   * 🔴 TRUE when the `$type` can return MEDIA — including a type whose PRIMARY
   * surface is text. See `chatCompletion` below; this flag exists because of it.
   */
  emitsMedia: boolean;
  /**
   * TRUE when the type's INPUT can carry an AIR URN (or a model reference that
   * resolves like one), so a submit must be screened against the entitlement
   * belt rather than trusted.
   *
   * 🔴 ADVISORY ONLY — it does NOT gate anything. The actual guard
   * (`screenSubmittedStepResources`) deep-scans the SUBMITTED input for every
   * type unconditionally, because a `false` here is a claim about the generated
   * schema and the schema is not what arrives at request time. This field exists
   * so a reviewer can see which types NEED an allowlist designed, not so the
   * scan can be skipped for the others.
   */
  airBearingInput: boolean;
  /**
   * The billing mode, or `null` when it is NOT ESTABLISHED.
   *
   * 🔴 `null` IS THE HONEST DEFAULT AND IT FAILS CLOSED. Deriving a billing mode
   * for a `$type` requires the orchestrator's rate card, which is not in this
   * repo and was not measured. Guessing one is the failure this field exists to
   * prevent: a type wrongly called `prepaidFixed` reserves a fixed amount for
   * something whose cost is not fixed. Only rows with real evidence carry a
   * value, and the evidence is named on the row.
   */
  billingMode: StepBillingMode | null;
};

/**
 * The per-`$type` policy table. TOTAL over the 43 `$type` values the generated
 * client declares.
 *
 * 🔴 A `$type` ABSENT FROM THIS TABLE IS NOT SUBMITTABLE. That is the whole
 * fail-closed mechanism, and it is why the table is an ALLOWLIST keyed by the
 * submitted `$type` rather than a set of denied types. When the orchestrator
 * adds a `$type`, apps cannot reach it until someone adds a row — which is the
 * reviewed-decision property the registry bought with registration, re-homed to
 * the only input that survives the pivot.
 */
const STEP_TYPE_POLICY_TABLE = {
  // ── TEXT-PRODUCING (model-generated) ──────────────────────────────────────
  // These seven are exactly the set `ACCEPTABLE_POSTURES_BY_TYPE` already
  // licenses for `'textOutput'`. The independent enumeration CONFIRMS that list
  // is correct as far as it goes — see `assertPolicyAgreesWithRegistryMap`,
  // which pins the agreement so the two cannot drift.
  chatCompletion: {
    textSurface: 'generatedText',
    textFields: [
      'choices[].message.content',
      'choices[].message.refusal',
      'choices[].message.tool_calls[].function.arguments',
      'choices[].finishReason',
    ],
    // 🔴 THE CROSS-AXIS CASE, AND THE REASON `emitsMedia` EXISTS AT ALL.
    // `ChatCompletionInput.modalities` ("Output modalities the model should
    // produce. Defaults to text-only when omitted.") makes this `$type` return
    // IMAGES on `choices[].message.images[].image_url.url` — a base64 data URI,
    // per the generated doc comment. So a purely text-posture treatment of
    // `chatCompletion` hands an app a MEDIA channel that the text scan does not
    // stand in front of.
    //
    // 🔴 THE REGISTRY CANNOT EXPRESS THIS STEP. Its output surface is MEDIA
    // **XOR** TEXT (`stepOutputShape`), and `index.ts` states the limit
    // explicitly: "A future orchestrator step that emits BOTH media and free
    // text cannot register at all under this rule — it fails at load rather than
    // half-registering... Nothing in the currently-licensed `$type` set has that
    // shape." That last sentence is FALSE as of `@civitai/client`
    // 0.2.0-beta.83 — `chatCompletion` is in the licensed set and has exactly
    // that shape. Recorded here rather than silently worked around; closing it
    // is a design decision, not an edit.
    emitsMedia: true,
    // `ChatCompletionInput.model` is a plain provider id ("gpt-4o"), NOT an AIR —
    // matching what `index.ts` already records. It still needs binding, but by a
    // model allowlist rather than by the AIR entitlement belt.
    airBearingInput: false,
    billingMode: null, // see `chatCompletion` note in the module footer
  },
  mediaCaptioning: {
    textSurface: 'generatedText',
    textFields: ['caption'],
    emitsMedia: false,
    airBearingInput: false,
    billingMode: null,
  },
  audioCaptioning: {
    textSurface: 'generatedText',
    textFields: [
      'results[].text',
      'results[].caption',
      'results[].lyrics',
      'results[].keyScale',
      'results[].timeSignature',
      'results[].language',
    ],
    emitsMedia: false,
    airBearingInput: false,
    billingMode: null,
  },
  transcription: {
    textSurface: 'generatedText',
    // 🔴 `timeStamps[].text` IS A SECOND, INDEPENDENT COPY of the transcript,
    // word by word. An extractor that returns only `text` scans the transcript
    // once and leaves the per-word copy unscanned — and the registry's
    // `extractText` contract makes "not returned" mean "not published", so the
    // safe reading is that BOTH must be returned or the capability is partial.
    textFields: ['text', 'timeStamps[].text'],
    emitsMedia: false,
    airBearingInput: false,
    billingMode: null,
  },
  promptEnhancement: {
    textSurface: 'generatedText',
    textFields: [
      'enhancedPrompt',
      'enhancedNegativePrompt',
      'recommendations[]',
      'issues[].description',
    ],
    emitsMedia: false,
    // `PromptEnhancementInput.images[]` are reference images, not AIRs.
    airBearingInput: false,
    billingMode: null,
  },
  xGuardModeration: {
    textSurface: 'generatedText',
    // 🔴 WIDER THAN THE REGISTRY'S NOTE. `index.ts` justifies listing this type
    // by `modelReason` alone. The enumeration finds the output ALSO echoes the
    // caller's own text back through `matchedTerms` — so this row is both
    // model-generated AND caller-echoed, and an extractor written to the
    // registry's stated rationale would cover only the first.
    textFields: [
      'results[].modelReason',
      'results[].postprocess',
      'results[].error',
      'results[].matchedTerms.text[]',
      'results[].matchedTerms.positivePrompt[]',
      'results[].matchedTerms.negativePrompt[]',
      'triggeredLabels[]',
    ],
    emitsMedia: false,
    airBearingInput: false,
    billingMode: null,
  },
  echo: {
    // Caller text straight back out. Classified `echoedInput` rather than
    // `generatedText` because that is what it IS — but note
    // `postureForTextSurface` gives the two the SAME answer, deliberately.
    textSurface: 'echoedInput',
    textFields: ['message'],
    emitsMedia: false,
    airBearingInput: false,
    billingMode: null,
  },

  // ── UNDECIDED — a domain owner must rule before these are submittable ──────
  // Each was named as an uncovered candidate by `index.ts` itself, or found by
  // this enumeration. They are NOT classified `'none'` (that would license
  // them) and NOT classified `'generatedText'` (that would assert a policy
  // nobody has set). They fail closed.
  imageResourceTraining: {
    // `sampleImagesPrompts[]` are the user's OWN prompts echoed back — the same
    // rationale `index.ts` uses to list `echo`, which it flags as "a live
    // inconsistency". This row records the inconsistency rather than resolving
    // it by fiat.
    //
    // 🔴 ONLY `sampleImagesPrompts[]` IS TEXT. The sibling string arrays
    // `epochs[].sampleImages[]` and `sampleInputImages[]` are BLOB NAMES per
    // their generated doc comments ("the names of the blobs that represent
    // sample images"), not prose — listing them here would overstate the
    // surface, and an over-broad `textFields` is how a reviewer stops trusting
    // the column.
    textSurface: 'undecidedNeedsDomainOwner',
    textFields: ['sampleImagesPrompts[]'],
    emitsMedia: true,
    airBearingInput: true, // `model` — "The primary model to train upon."
    billingMode: null,
  },
  mediaRating: {
    textSurface: 'undecidedNeedsDomainOwner',
    textFields: ['blockedReason', 'labels[]', 'ageClassification.error'],
    emitsMedia: false,
    airBearingInput: false,
    billingMode: null,
  },
  modelParseMetadata: {
    // 🔴 THE `__metadata__` JSON header OF A USER-UPLOADED SAFETENSORS. Wholly
    // attacker-controlled text, from a file the uploader chose, surfaced as one
    // string.
    textSurface: 'undecidedNeedsDomainOwner',
    textFields: ['metadata'],
    emitsMedia: false,
    airBearingInput: true, // `model` — "The AIR of the model file to read metadata from."
    billingMode: null,
  },
  modelClamScan: {
    textSurface: 'undecidedNeedsDomainOwner',
    textFields: ['output'],
    emitsMedia: false,
    airBearingInput: true,
    billingMode: null,
  },
  modelPickleScan: {
    // `globalImports` / `dangerousImports` are Python import paths read out of a
    // user-uploaded pickle — attacker-chosen strings, published verbatim.
    textSurface: 'undecidedNeedsDomainOwner',
    textFields: ['output', 'skipReason', 'globalImports[]', 'dangerousImports[]'],
    emitsMedia: false,
    airBearingInput: true,
    billingMode: null,
  },
  qwenImageBench: {
    // 🔴 TWO error surfaces, not one: a per-item `error` AND an `errors` MAP
    // keyed by benchmark dimension. `index.ts` names only "`qwenImageBench.errors`";
    // the map's VALUES are the strings, and the scalar `error` is a separate
    // field. Both are recorded because an extractor written from the registry's
    // wording would miss one of them.
    textSurface: 'undecidedNeedsDomainOwner',
    textFields: ['results[].error', 'results[].errors[]', 'results[].scores[].name'],
    emitsMedia: false,
    airBearingInput: true, // `model` — "The AIR model to use for the benchmark judge."
    billingMode: null,
  },
  imageGen: {
    // 🔴 NOT NAMED BY `index.ts`. `errors[]` is "An optional list of errors
    // related to generation failures" — free-form provider strings on an
    // otherwise media-only type.
    textSurface: 'undecidedNeedsDomainOwner',
    textFields: ['errors[]'],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  ageClassification: {
    // `labels[<imageKey>][].age` — a classifier label ("adult"/"child"), i.e. a
    // bounded vocabulary rather than prose. Classified UNDECIDED not because the
    // string is free-form but because publishing per-image age classifications
    // to an app is a disclosure question, which is a domain owner's to answer.
    textSurface: 'undecidedNeedsDomainOwner',
    textFields: ['labels[][].age'],
    emitsMedia: false,
    airBearingInput: true,
    billingMode: null,
  },

  // ── NO FREE-TEXT OUTPUT ───────────────────────────────────────────────────
  // Structural strings only (blob urls, expiry timestamps, ids, hashes, format
  // enums). Each was checked against its enumerated field list; the paths are
  // recorded as empty because `textFields` means FREE TEXT, not "strings".
  convertImage: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    // 🔴 THE ONE EVIDENCED BILLING MODE, and the evidence is the shipped
    // registry entry: `convert-image.step.ts` declares `prepaidFixed`, and the
    // registry's clause-6 load-time invariant proves price and estimate agree
    // for every variant. This row therefore agrees with a value that is already
    // enforced elsewhere rather than asserting a new one.
    billingMode: 'prepaidFixed',
  },
  aceStepAudio: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: true,
    billingMode: null,
  },
  blobArchive: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  comfy: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  comfyNodepackSnapshot: {
    // `nodepack` / `layerAir` are AIRs, not prose — structural identifiers.
    textSurface: 'none',
    textFields: [],
    emitsMedia: false,
    airBearingInput: true,
    billingMode: null,
  },
  composeMedia: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  customComfy: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: true,
    billingMode: null,
  },
  imageBackgroundRemoval: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  imageToSvg: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  imageUpload: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  imageUpscaler: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    // The named bypass case in `index.ts`: `model` takes an arbitrary AIR URN.
    airBearingInput: true,
    billingMode: null,
  },
  mediaHash: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: false,
    airBearingInput: false,
    billingMode: null,
  },
  model3DPreview: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: true,
    billingMode: null,
  },
  modelHash: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: false,
    airBearingInput: true,
    billingMode: null,
  },
  polyGen: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  preprocessImage: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  textToImage: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: true,
    billingMode: null,
  },
  textToSpeech: {
    // `modelType` / `speaker` are bounded labels ("base" | "custom_voice", a
    // speaker name), not free text. The FREE-TEXT INPUT axis of this type is a
    // separate, still-open question `index.ts` documents at length.
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  training: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: true,
    billingMode: null,
  },
  transcode: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  videoBackgroundRemoval: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  videoEnhancement: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: true,
    billingMode: null,
  },
  videoFrameExtraction: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  videoGen: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  videoInterpolation: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: true,
    billingMode: null,
  },
  videoMetadata: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: false,
    airBearingInput: false,
    billingMode: null,
  },
  videoUpscaler: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: true,
    airBearingInput: false,
    billingMode: null,
  },
  wdTagging: {
    textSurface: 'none',
    textFields: [],
    emitsMedia: false,
    airBearingInput: true,
    billingMode: null,
  },
} satisfies Record<string, StepTypePolicy>;

/**
 * The policy table, frozen and NULL-PROTOTYPED.
 *
 * 🔴 THE NULL PROTOTYPE IS A CONTROL, NOT A STYLE CHOICE, and this module is
 * exactly where it matters: the key is the `$type` an UNTRUSTED app submitted.
 * On a plain object literal, `lookupStepTypePolicy('toString')` returns
 * `Object.prototype.toString` — TRUTHY — so every `if (!policy) reject` guard
 * below would evaluate `false` and the submit would proceed with a "policy" that
 * is a function. That is the fail-OPEN inversion, reachable by a chosen input,
 * and it is the same defect this codebase already fixed twice (the registry's
 * `STEP_TYPE_ACCEPTABLE_POSTURES`, and `./moderation`'s handler table). With a
 * null prototype every non-own key reads `undefined` and every guard fails
 * closed.
 *
 * Frozen at BOTH levels for the same reason the registry freezes its map: a
 * shallow freeze leaves each row mutable, and `readonly` is a compile-time
 * fiction a runtime assignment walks straight through.
 */
export const STEP_TYPE_POLICY: Readonly<Record<string, StepTypePolicy>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, StepTypePolicy>,
    Object.fromEntries(
      Object.entries(STEP_TYPE_POLICY_TABLE).map(([type, policy]) => [
        type,
        Object.freeze({ ...policy, textFields: Object.freeze([...policy.textFields]) }),
      ])
    )
  )
);

/** The `$type` values this module has a policy row for. */
export const POLICIED_STEP_TYPES: readonly string[] = Object.freeze(
  Object.keys(STEP_TYPE_POLICY_TABLE)
);

/**
 * The policy for a submitted `$type`, or `undefined` when there is none.
 *
 * 🔴 `undefined` MEANS "REJECT", NEVER "UNCONSTRAINED". That is the inversion of
 * the registry's `acceptablePosturesFor`, which returns `undefined` for "no
 * declared constraint — every posture is acceptable". That reading is correct
 * THERE (the population is a reviewed registry, so an unlisted type still went
 * through review) and would be catastrophic HERE (the population is whatever an
 * untrusted app sends). Callers below encode the reject; this accessor is
 * deliberately the only place the raw `undefined` is visible.
 */
export function lookupStepTypePolicy(orchestratorType: string): StepTypePolicy | undefined {
  return STEP_TYPE_POLICY[orchestratorType];
}

/**
 * A fail-closed decision. `ok: false` carries a `code` a caller can branch on
 * and a `reason` safe to surface.
 *
 * 🔴 THE MESSAGE REACHES THE UNTRUSTED IFRAME. `trpc.ts`'s `errorFormatter` is
 * pass-through, so every `reason` below is echoed to the app's own JS. They name
 * the `$type` the app itself sent and the policy class — never an internal
 * allowlist, a model id, or another app's data.
 */
export type PolicyDecision<T> =
  | { ok: true; value: T }
  | { ok: false; code: PolicyRejectionCode; reason: string };

export type PolicyRejectionCode =
  /** No policy row for the submitted `$type`. */
  | 'unknownStepType'
  /** The row exists but its classification is an open domain-owner question. */
  | 'undecidedTextSurface'
  /** The submitted input carries an AIR and the type has no entitlement gate. */
  | 'unentitledResourceReference'
  /** No billing mode is established for the type. */
  | 'billingModeNotEstablished';

/**
 * The moderation posture REQUIRED for a text surface, or `null` when the surface
 * is not one this host is prepared to publish.
 *
 * 🔴 `'echoedInput'` AND `'generatedText'` GET THE SAME ANSWER, AND THAT IS A
 * DELIBERATE COST. It is defensible to argue an echoed surface is fully covered
 * by auditing the input — for `echo` the output IS the input. `index.ts` already
 * considered exactly this for `echo` and chose the conservative answer, because
 * the relaxation asserts that auditing input suffices for a text-EMITTING step,
 * which is a subsumption judgment the posture model declines to make anywhere
 * else. Making the same choice here keeps the two layers consistent; changing it
 * is a policy decision and should change both.
 */
export function postureForTextSurface(surface: StepTextSurface): StepModerationPosture | null {
  switch (surface) {
    case 'none':
      return 'none';
    case 'generatedText':
    case 'echoedInput':
      return 'textOutput';
    case 'undecidedNeedsDomainOwner':
      // 🔴 NOT A POSTURE. Returning `'none'` here would license the surface;
      // returning `'textOutput'` would assert the scan is the right answer for
      // a raw ClamAV dump or a safetensors header. Both are decisions this
      // module is not entitled to make, so it makes neither.
      return null;
  }
}

/**
 * GUARD 1 — MODERATION POSTURE, derived from the SUBMITTED `$type`.
 *
 * Re-homes `ACCEPTABLE_POSTURES_BY_TYPE` from a registration-time check of an
 * entry's DECLARATION to a request-time lookup on what was actually sent.
 *
 * FAILS CLOSED on an unlisted `$type` and on an undecided classification.
 */
export function requiredPostureForSubmittedType(
  orchestratorType: string
): PolicyDecision<StepModerationPosture> {
  const policy = lookupStepTypePolicy(orchestratorType);
  if (!policy) {
    return {
      ok: false,
      code: 'unknownStepType',
      reason:
        `orchestrator step type '${orchestratorType}' has no declared moderation policy — ` +
        'a step type must be classified before an app may submit it, so the request is ' +
        'rejected rather than submitted with no posture',
    };
  }
  const posture = postureForTextSurface(policy.textSurface);
  if (posture === null) {
    return {
      ok: false,
      code: 'undecidedTextSurface',
      reason:
        `orchestrator step type '${orchestratorType}' carries an output text surface whose ` +
        'moderation treatment is an open policy question — the request is rejected rather ' +
        'than publishing text under a guessed posture',
    };
  }
  return { ok: true, value: posture };
}

/**
 * GUARD 2 — RESOURCE / ENTITLEMENT POLICY, run on the APP-SUPPLIED step input.
 *
 * Re-homes the registry's `resourcePolicy` + clause-7 deep AIR scan. Under the
 * registry the scan proved a DECLARATION ('none') was not a lie; here there is
 * no declaration, so the scan IS the policy.
 *
 * 🔴 THE SCAN RUNS FOR EVERY `$type`, INCLUDING `airBearingInput: false` ONES.
 * That flag describes the generated SCHEMA; what arrives at request time is a
 * JSON object an app built, and an app is free to put a `urn:air:` string in a
 * field the schema calls a caption. Gating the scan on the flag would trust the
 * schema to constrain the payload, which is precisely the assumption the pivot
 * removes.
 *
 * FAIL-CLOSED DIRECTION, stated honestly and unchanged from the router's
 * existing re-assert: `containsAirReference` is a substring test for `urn:air:`
 * anywhere in the input, so a value that merely EMBEDS that literal (a
 * Civitai-hosted url whose path contains it) is rejected too. Refusing a
 * pathological url costs one bounced request; forwarding an unentitled AIR costs
 * the entitlement belt.
 */
export function screenSubmittedStepResources(submitted: {
  orchestratorType: string;
  input: unknown;
}): PolicyDecision<'noResourceReference'> {
  const policy = lookupStepTypePolicy(submitted.orchestratorType);
  if (!policy) {
    return {
      ok: false,
      code: 'unknownStepType',
      reason:
        `orchestrator step type '${submitted.orchestratorType}' has no declared resource ` +
        'policy — the request is rejected rather than submitted with no entitlement gate',
    };
  }
  // 🔴 THE SAME `containsAirReference` THE REGISTRY USES, imported rather than
  // re-implemented. A second copy of a deep scan is a second thing to get wrong,
  // and this one is on the entitlement path.
  if (containsAirReference(submitted.input)) {
    return {
      ok: false,
      code: 'unentitledResourceReference',
      reason:
        `the submitted '${submitted.orchestratorType}' step carries an AIR resource ` +
        'reference, and no entitlement allowlist is implemented for app-composed steps — a ' +
        'step that reaches an AIR resource bypasses the generation-graph entitlement belt',
    };
  }
  return { ok: true, value: 'noResourceReference' };
}

/**
 * GUARD 3 — BILLING MODE, derived from the SUBMITTED `$type`.
 *
 * Re-homes the registry's per-entry `billingMode` declaration. FAILS CLOSED on
 * an unlisted type AND on a listed type whose mode is not established — the
 * common case today, deliberately (see `StepTypePolicy.billingMode`).
 */
export function billingModeForSubmittedType(
  orchestratorType: string
): PolicyDecision<StepBillingMode> {
  const policy = lookupStepTypePolicy(orchestratorType);
  if (!policy) {
    return {
      ok: false,
      code: 'unknownStepType',
      reason:
        `orchestrator step type '${orchestratorType}' has no declared billing mode — the ` +
        'request is rejected rather than reserved against a guessed money path',
    };
  }
  if (policy.billingMode === null) {
    return {
      ok: false,
      code: 'billingModeNotEstablished',
      reason:
        `orchestrator step type '${orchestratorType}' has no established billing mode — ` +
        'estimate, reservation and settle all dispatch on it, so the request is rejected ' +
        'rather than riding another mode’s reservation logic',
    };
  }
  return { ok: true, value: policy.billingMode };
}

/** Everything the three guards decided for one submitted step. */
export type SubmittedStepDecision = {
  orchestratorType: string;
  posture: StepModerationPosture;
  billingMode: StepBillingMode;
  policy: StepTypePolicy;
};

/**
 * THE COMPOSITE GATE — all three guards, in the order a submit path wants them.
 *
 * 🔴 ORDER IS CHOSEN, NOT INCIDENTAL. Posture first (it rejects the widest class
 * and its message is the most actionable), then resources (a cheap pure scan),
 * then billing. Every one of them must pass; there is no partial success. A
 * caller that wants a single call is expected to use this rather than
 * re-composing the three, because re-composing is where a caller forgets one.
 *
 * 🔴 PURE AND SYNCHRONOUS. It performs no IO and reads no session — it is a
 * function of the submitted `$type` and `input` only. That is what makes it
 * unit-testable without a request context, and what lets the registry path call
 * it at module load.
 */
export function evaluateSubmittedStep(submitted: {
  orchestratorType: string;
  input: unknown;
}): PolicyDecision<SubmittedStepDecision> {
  const posture = requiredPostureForSubmittedType(submitted.orchestratorType);
  if (!posture.ok) return posture;

  const resources = screenSubmittedStepResources(submitted);
  if (!resources.ok) return resources;

  const billing = billingModeForSubmittedType(submitted.orchestratorType);
  if (!billing.ok) return billing;

  // `lookupStepTypePolicy` cannot be `undefined` here — all three guards above
  // return `unknownStepType` first. Re-read rather than threaded through so
  // there is one lookup site per guard and no shared mutable state.
  const policy = lookupStepTypePolicy(submitted.orchestratorType) as StepTypePolicy;
  return {
    ok: true,
    value: {
      orchestratorType: submitted.orchestratorType,
      posture: posture.value,
      billingMode: billing.value,
      policy,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WIRING INTO THE CURRENT REGISTRY PATH — so this module is EXERCISED, not dead
// code waiting for a widening that has not shipped.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cross-check a REGISTERED entry's declarations against the request-time policy
 * derived for the `$type` it submits.
 *
 * 🔴 WHAT THIS BUYS, STATED NARROWLY. It does NOT re-enforce the registry's
 * clauses; those still run and still fail at load. It pins the two layers to
 * ONE answer, so the request-time table cannot quietly drift away from the
 * declarations the registry is enforcing — which is the failure mode a
 * parallel policy table has. When the pivot removes the declarations, this
 * function's callers disappear and the table it validates becomes the only
 * copy; until then it is the thing keeping them honest.
 *
 * Deliberately takes the three fields rather than an `AnyBlockStep`, so a test
 * can drive it with a fixture that no registry entry could legally hold.
 */
export function assertRegistryEntryAgreesWithPolicy(entry: {
  id: string;
  orchestratorType: string;
  moderationPosture: StepModerationPosture;
  billingMode: StepBillingMode;
}): void {
  const where = `block step '${entry.id}'`;
  const posture = requiredPostureForSubmittedType(entry.orchestratorType);
  if (!posture.ok) {
    throw new Error(
      `${where}: orchestratorType '${entry.orchestratorType}' has no request-time policy row ` +
        `(${posture.code}) — a registered entry must be submittable under the same policy that ` +
        'will govern app-composed steps, or the two layers disagree about the same $type'
    );
  }
  if (posture.value !== entry.moderationPosture) {
    throw new Error(
      `${where}: declares moderationPosture '${entry.moderationPosture}' but the request-time ` +
        `policy for '${entry.orchestratorType}' requires '${posture.value}' — the registry and ` +
        'the request-time gate would treat the same $type differently'
    );
  }
  const billing = billingModeForSubmittedType(entry.orchestratorType);
  // 🔴 A `billingModeNotEstablished` row is NOT a failure here, and that
  // asymmetry is deliberate. The registry's own clause 10 already proves the
  // entry's mode has an implemented money-path handler; this table's `null`
  // means "not established for APP-COMPOSED submission", which is a stricter
  // question with a different answer. Failing on it would block the shipped
  // `convert-image` entry for having a mode the pivot has not yet ratified.
  // Only a CONTRADICTION — both sides state a mode and they differ — is an
  // error.
  if (billing.ok && billing.value !== entry.billingMode) {
    throw new Error(
      `${where}: declares billingMode '${entry.billingMode}' but the request-time policy for ` +
        `'${entry.orchestratorType}' establishes '${billing.value}' — estimate, reservation and ` +
        'settle dispatch on this value, so two answers is a money-path ambiguity'
    );
  }
}

/**
 * Cross-check this module's derived postures against the registry's own
 * `$type` → acceptable-postures map, for every `$type` BOTH cover.
 *
 * 🔴 WHY A SEPARATE ASSERT. `assertRegistryEntryAgreesWithPolicy` only sees
 * `$type`s that a registered ENTRY claims — exactly one today (`convertImage`).
 * The registry's map licenses seven `$type`s no entry has yet claimed, and those
 * seven are the ones this module's classification is most likely to get wrong.
 * This walks that whole map instead, so the agreement is checked over the
 * population that matters rather than over the single shipped entry.
 *
 * Takes the map as an argument so a test can drive it with a DISAGREEING
 * fixture — a guard only exercised by the shipped constant is a guard nobody has
 * seen fail.
 */
export function assertPolicyAgreesWithRegistryMap(
  registryMap: Readonly<Record<string, readonly StepModerationPosture[]>>
): void {
  for (const [orchestratorType, acceptable] of Object.entries(registryMap)) {
    const derived = requiredPostureForSubmittedType(orchestratorType);
    if (!derived.ok) {
      throw new Error(
        `request-time policy: the registry licenses postures for '${orchestratorType}' but this ` +
          `module derives none (${derived.code}) — the two layers disagree about whether that ` +
          '$type may be submitted at all'
      );
    }
    if (!acceptable.includes(derived.value)) {
      throw new Error(
        `request-time policy: derives posture '${derived.value}' for '${orchestratorType}', but ` +
          `the registry accepts only ${acceptable.map((p) => `'${p}'`).join(' or ')} — a ` +
          'registered entry and an app-composed step would be moderated differently'
      );
    }
  }
}
