import { REGISTERED_RECIPE_IDS, type RegisteredRecipeId } from './recipes';
import { REGISTERED_STEP_IDS } from './steps';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks GENERATION TYPE — the app-facing key for "what kind of generation
// was this", resolved from a submitted `BlockWorkflowBody` (plus, on the image
// path, the workflow type the graph actually ran) and persisted on the
// spend-attribution row (`block_spend_attribution.generation_type`).
//
// WHY IT EXISTS. Every block-initiated generation writes one spend-attribution
// row, but the row carried no record of WHICH capability was run — a txt2img
// submit and a chat-completion submit were indistinguishable in the table that
// exists to answer "what did this app's users spend on". That matters now
// because the author fee is moving to a PER-GENERATION-TYPE setting, and a fee
// per type cannot be reasoned about from data that never recorded the type.
// Recording it is a prerequisite: an untyped event can never be typed
// retrospectively, so the column goes in ahead of the fee itself.
//
// ── THE VALUE GRAMMAR ───────────────────────────────────────────────────────
//
//   value   ::= coarse | coarse ":" subtype
//   coarse  ::= "textToImage" | "customComfy" | <registered step id>
//   subtype ::= a COLON-FREE token from the closed set that coarse key allows
//
// 🔴 THE COARSE KEY IS EVERYTHING BEFORE THE FIRST COLON, AND A VALUE CARRIES
// AT MOST ONE COLON. Both halves of that rule are load-bearing and both are
// pinned by tests. The per-generation-type author fee keys on the COARSE key,
// so `value.split(':')[0]` must keep working, unchanged, no matter how deep the
// subtype axis grows. A bare `txt2img` would destroy the key the fee looks up;
// a second colon (`textToImage:img2img:edit`) would still decompose correctly
// under "before the FIRST colon", but it is REFUSED anyway so that the whole
// value stays a two-field record with no escaping rule to get wrong. That is
// why the graph's `img2img:edit` is spelled `img2img-edit` here — the one place
// the two vocabularies are translated is `IMAGE_SUBTYPE_BY_WORKFLOW` below.
// The refusal is structural rather than a separate check: every allowed subtype
// is colon-free, so the membership test in `isBlockGenerationType` enforces it.
// See the note there for why no standalone guard is written.
//
// Today's values, in full:
//
//   textToImage:txt2img        textToImage:img2img        textToImage:img2img-edit
//   customComfy:<recipe id>    customComfy:inline
//   convert-image              chat-completion
//
// A bare `textToImage` / `customComfy` is still a legal value: it is what a
// submit degrades to when the sub-axis cannot be established (see RESOLUTION
// below). It is shallower, never wrong.
//
// 🔴 THE VALUE IS THE APP-FACING ID, NEVER THE ORCHESTRATOR `$type`. For
// `kind: 'step'` the coarse key is the REGISTERED STEP ID (`convert-image`,
// `chat-completion`) — the id the registry calls "a permanent public wire
// commitment" — and NOT the entry's `orchestratorType` (`convertImage`,
// `chatCompletion`), which is the orchestrator's own internal spelling and is
// free to change without a wire-contract decision. The two are one refactor
// apart from disagreeing, and the durable column must follow the stable one.
// The same rule governs the `customComfy` subtype: it is the REGISTERED RECIPE
// ID, the value the wire schema's `recipe` enum is derived from.
//
// ── WHY ONE COLUMN: A COLLISION DECISION *AND* A DEPTH DECISION ─────────────
//
// COLLISION. A step id implies `kind: 'step'`, so ONE column is enough — no
// companion `kind` column. That reading holds as long as no registered step id
// collides with `textToImage` / `customComfy`. ⚠️ NOTHING ENFORCES THAT: the
// registry's load-time invariants pin `step.id === <registry key>` and
// uniqueness of `orchestratorType`, but neither knows these two strings exist.
// Today the two sets are disjoint; if a future entry were registered under one
// of those names the column would become ambiguous, so it is called out here
// rather than assumed. Registering a step is a reviewed PR, which is where that
// is caught.
//
// DEPTH. 🔴 THE SECOND DECISION, AND THE ONE AN EARLIER REVISION OF THIS HEADER
// DID NOT MAKE AT ALL. One column also fixes HOW FINELY the generation axis is
// sampled, and the first cut sampled it at two different depths: `kind: 'step'`
// recorded the capability while the other two recorded only the `kind`,
// discarding sub-axes that were real, already available, and recorded nowhere
// else. Because an untyped event can never be typed retrospectively — the whole
// premise of the column — those sub-axes were being permanently lost. They are
// captured now, at the same depth as a step id, which is what the `<coarse>:
// <subtype>` grammar exists for.
//
// 🔴 WHAT IS STILL NOT CAPTURED, stated so the next depth decision is made on
// purpose rather than by omission:
//   - the IMAGE ecosystem / checkpoint (SD-family vs Flux vs OpenAI …). The
//     row already carries `model_id`, so this is recoverable; the workflow
//     class was not.
//   - `quantity`, and the LoRA fan-out (`additionalResources`) on an image
//     submit. Both are cost inputs, not capability axes; the money basis is
//     already on the row.
//   - the inline `customComfy` GRAPH. `customComfy:inline` is deliberately ONE
//     bucket: an inline graph is app-authored and has no stable server-side
//     identity to key a fee on, which is precisely the difference between it
//     and a registered recipe.
//   - a step's own PARAMS (e.g. which chat model a `chat-completion` used).
//     That is a third level and belongs in the step invocation row, which
//     already records `detail`.
//
// 🔴 NO DB CHECK CONSTRAINT / NO ENUM. Both registries are explicitly designed
// to grow ADDITIVELY — "future step types must be ADDITIVE (register an entry)
// rather than a schema change" — and a CHECK would turn every new registered
// step or recipe into a database migration, defeating that. The bound is
// enforced HERE, in code, against the same registries the wire schema derives
// its enums from.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two non-registry `kind`s, which are their own coarse generation type.
 * Kept as a literal tuple (rather than derived from the zod union) because
 * these are wire discriminants: a rename is a breaking change that must be made
 * deliberately, and this list is what a reader diffs against.
 */
export const BLOCK_WORKFLOW_KIND_GENERATION_TYPES = ['textToImage', 'customComfy'] as const;

/**
 * Every COARSE key — the first `:`-delimited segment, and the only thing the
 * per-generation-type author fee keys on. DERIVED from the step registry, so
 * registering a step widens this automatically.
 */
export const BLOCK_GENERATION_COARSE_TYPES: readonly string[] = [
  ...BLOCK_WORKFLOW_KIND_GENERATION_TYPES,
  ...REGISTERED_STEP_IDS,
];

/**
 * The image workflow class → generation SUBTYPE spelling.
 *
 * 🔴 AN ARRAY OF PAIRS, NOT AN OBJECT MAP, and that is a safety property rather
 * than a style choice. The left-hand values are matched against an `unknown`
 * arriving from the graph input, and indexing an object literal with an
 * untrusted key fails OPEN — `({}as any)['toString']` is truthy. A `.find` over
 * a tuple array has no prototype to fall through to. Same hazard, same cure, as
 * the `getStep` note on the step arm below.
 *
 * 🔴 THE LEFT SIDE MIRRORS `BLOCK_IMAGE_WORKFLOW_TYPES` in `workflow.service`
 * and is deliberately a LITERAL here rather than an import: this module is
 * pulled in by `buzz-attribution.service` on the fire-and-forget spend path and
 * must stay import-light, while `workflow.service` pulls in the whole
 * generation-graph pipeline. `generation-type.test.ts` imports both and pins the
 * two sets equal in BOTH directions, so a fourth image workflow class cannot be
 * added without this map being updated — the derivation cannot drift silently.
 *
 * The right side translates `img2img:edit` to `img2img-edit`, because a subtype
 * must be colon-free (see THE VALUE GRAMMAR above). This is the ONLY place the
 * graph vocabulary and the analytics vocabulary are translated.
 */
const IMAGE_SUBTYPE_BY_WORKFLOW = [
  ['txt2img', 'txt2img'],
  ['img2img', 'img2img'],
  ['img2img:edit', 'img2img-edit'],
] as const;

export type BlockImageGenerationSubtype = (typeof IMAGE_SUBTYPE_BY_WORKFLOW)[number][1];

/** The closed subtype set for the `textToImage` coarse key. */
export const BLOCK_IMAGE_GENERATION_SUBTYPES: readonly string[] = IMAGE_SUBTYPE_BY_WORKFLOW.map(
  ([, subtype]) => subtype
);

/**
 * The subtype for a `customComfy` body carrying the graph itself rather than a
 * registered recipe id. One bucket by design — see the DEPTH note above.
 */
export const CUSTOM_COMFY_INLINE_SUBTYPE = 'inline';

/** The closed subtype set for the `customComfy` coarse key. */
export const CUSTOM_COMFY_GENERATION_SUBTYPES: readonly string[] = [
  ...REGISTERED_RECIPE_IDS,
  CUSTOM_COMFY_INLINE_SUBTYPE,
];

export type BlockGenerationType =
  | 'textToImage'
  | `textToImage:${BlockImageGenerationSubtype}`
  | 'customComfy'
  | `customComfy:${RegisteredRecipeId | typeof CUSTOM_COMFY_INLINE_SUBTYPE}`
  | (typeof REGISTERED_STEP_IDS)[number];

/**
 * The closed subtype set a given COARSE key allows.
 *
 * A registered step id gets the EMPTY set, not a wildcard: a step carries no
 * subtype today, so `convert-image:anything` must be refused rather than
 * waved through as "some future step subtype".
 */
function blockGenerationSubtypesFor(coarse: string): readonly string[] {
  if (coarse === 'textToImage') return BLOCK_IMAGE_GENERATION_SUBTYPES;
  if (coarse === 'customComfy') return CUSTOM_COMFY_GENERATION_SUBTYPES;
  return [];
}

/**
 * Every generation type that can currently be persisted. DERIVED from both
 * registries, so registering a step or a recipe widens it automatically.
 *
 * 🔴 THIS IS A LEDGER, NOT THE BOUND. `isBlockGenerationType` is the bound, and
 * it validates a SHAPE rather than consulting this list — see the note on that
 * function for why. This enumeration exists so a test can assert the two agree
 * in BOTH directions over the whole population, which is what turns a widened
 * registry into a visible change rather than a silent one.
 */
export const BLOCK_GENERATION_TYPES: readonly BlockGenerationType[] = [
  ...BLOCK_WORKFLOW_KIND_GENERATION_TYPES,
  ...BLOCK_IMAGE_GENERATION_SUBTYPES.map((s) => `textToImage:${s}`),
  ...CUSTOM_COMFY_GENERATION_SUBTYPES.map((s) => `customComfy:${s}`),
  ...REGISTERED_STEP_IDS,
] as readonly BlockGenerationType[];

/**
 * Is `value` a generation type this build knows how to persist?
 *
 * 🔴 A SHAPE TEST, NOT A MEMBERSHIP TEST — and the widening is exactly why. The
 * first cut of this column had a closed literal value set, so an
 * `Array.includes` over a derived list was a complete bound. Interpolating
 * registry ids into the value makes the space COMPOSITE, and a flat membership
 * test over a precomputed cross-product would have to be regenerated in lockstep
 * with two registries. So the bound is stated structurally instead, and these
 * are the properties it GUARANTEES — not a checklist of the lines below, which
 * are deliberately fewer (see the note in the body):
 *
 *   - the COARSE key (everything before the first colon) is in the closed
 *     `BLOCK_GENERATION_COARSE_TYPES`;
 *   - there is AT MOST ONE colon — the subtype is colon-free;
 *   - the subtype is non-empty and in the closed set that coarse key allows,
 *     which for a registered step id is the EMPTY set (a step carries no
 *     subtype, so `convert-image:anything` is refused rather than waved
 *     through as "some future step subtype").
 *
 * 🔴 EVERY LOOKUP IS AN ARRAY MEMBERSHIP TEST, DELIBERATELY — never an index
 * into a registry object. `getStep(id)` / `getRecipe(id)` index plain object
 * literals, so `getStep('toString')` returns `Function.prototype.toString`
 * (truthy) and a prototype key would sail through a `getRecipe(x) ? x : null`
 * guard and land in the column. Widening the value space does NOT relax that:
 * a recipe id interpolated into the subtype is the same hazard class as a step
 * id was, so it is bounded the same way.
 *
 * Total and non-throwing: returns `false`, never raises, for any input.
 */
export function isBlockGenerationType(value: unknown): value is BlockGenerationType {
  if (typeof value !== 'string' || value.length === 0) return false;

  const firstColon = value.indexOf(':');
  if (firstColon === -1) {
    return BLOCK_GENERATION_COARSE_TYPES.includes(value);
  }

  // 🔴 ONE MEMBERSHIP TEST, NOT FOUR — AND THE MISSING THREE ARE A DELIBERATE
  // DELETION, NOT AN OVERSIGHT. Separate checks for "the coarse key is known",
  // "at most one colon" and "the subtype is non-empty" were all written, and a
  // mutation sweep proved NONE of them could be turned red: `subtypesFor`
  // returns the EMPTY set for an unknown coarse key, and every member of every
  // allowed set is colon-free and non-empty, so this single line already refuses
  // `videoToVideo:txt2img`, `textToImage:img2img:edit` and `textToImage:`. A
  // guard no test can turn red is worse than no guard — it reads as coverage
  // while providing none, which is how a reviewer is talked out of looking.
  //
  // So the whole bound on the composite half is ONE rule in ONE place: the
  // allowed-subtype set for this coarse key. The one way such a set could ever
  // admit a colon is a REGISTRY ID containing one (recipe ids are interpolated
  // verbatim). That is pinned at REGISTRATION time by the "no registry id
  // contains a colon" invariant guard in `generation-type.test.ts` — where a new
  // entry trips it — rather than here at runtime, where the value would already
  // have been written.
  return blockGenerationSubtypesFor(value.slice(0, firstColon)).includes(
    value.slice(firstColon + 1)
  );
}

/**
 * Build a value from a coarse key and an optional subtype, bounded.
 *
 * 🔴 THE ONE PLACE A VALUE IS CONSTRUCTED, and it validates its own output with
 * `isBlockGenerationType`. That is what makes it structurally impossible for the
 * resolver to emit something the write-side re-check would then refuse — the
 * two cannot disagree, because there is only one bound and the producer runs it.
 *
 * DEGRADES TO THE COARSE KEY when the subtype is unusable (unregistered,
 * colon-bearing, empty). A shallower TRUE value beats both a wrong one and a
 * null one here: the coarse key is what the per-generation-type fee looks up, so
 * dropping to it costs depth and nothing else, whereas returning `null` would
 * throw away a fact that is certainly correct. Returns `null` only when the
 * coarse key itself is not one this build knows.
 */
export function composeBlockGenerationType(
  coarse: string,
  subtype: string | null
): BlockGenerationType | null {
  if (subtype !== null) {
    const composed = `${coarse}:${subtype}`;
    if (isBlockGenerationType(composed)) return composed;
  }
  return isBlockGenerationType(coarse) ? coarse : null;
}

/**
 * The image SUBTYPE for the workflow class the generation graph actually ran.
 *
 * Takes `unknown` because the caller reads it off the graph input record
 * (`Record<string, unknown>`), which is where the authoritative value lives —
 * see `resolveBlockGenerationType`. Anything unrecognised is `null`, which
 * degrades the value to the bare coarse key.
 */
function imageGenerationSubtype(imageWorkflowType: unknown): string | null {
  if (typeof imageWorkflowType !== 'string') return null;
  const pair = IMAGE_SUBTYPE_BY_WORKFLOW.find(([workflow]) => workflow === imageWorkflowType);
  return pair ? pair[1] : null;
}

/**
 * The `customComfy` SUBTYPE for a submitted body: which arm, and — on the
 * recipe arm — which registered recipe.
 *
 * Both arms are read straight off the body, which is where the wire schema put
 * them; `mode` is the arm discriminator and is `.optional()` on the recipe arm
 * (an absent `mode` IS a recipe body — every deployed app sends one). The recipe
 * id is returned RAW and bounded by `composeBlockGenerationType` against
 * `REGISTERED_RECIPE_IDS`, so there is exactly one place the registry is
 * consulted and no second copy of the bound to drift.
 */
function customComfyGenerationSubtype(body: object): string | null {
  const mode = (body as { mode?: unknown }).mode;
  if (mode === CUSTOM_COMFY_INLINE_SUBTYPE) return CUSTOM_COMFY_INLINE_SUBTYPE;
  // An unknown `mode` is not a recipe body. The wire schema rejects it, so this
  // is defense in depth — but reading `recipe` off a body that declared some
  // third arm would be guessing, and the coarse key is the honest answer.
  if (mode !== undefined && mode !== 'recipe') return null;
  const recipe = (body as { recipe?: unknown }).recipe;
  return typeof recipe === 'string' ? recipe : null;
}

/** Optional authoritative context a caller can supply to deepen the value. */
export type BlockGenerationTypeContext = {
  /**
   * The image workflow class the generation graph ACTUALLY ran — one of
   * `txt2img` / `img2img` / `img2img:edit`.
   *
   * 🔴 THIS CANNOT BE DERIVED FROM THE BODY, which is why it is a parameter. A
   * body with a source image maps to `img2img` on an SD-family ecosystem and to
   * `img2img:edit` on an edit-capable one (OpenAI/Qwen/Flux Kontext/…); the
   * discriminator is the CHECKPOINT'S ECOSYSTEM, resolved by
   * `resolveBlockImageWorkflowType` inside `buildImageWorkflowInput`. The
   * router passes the value that builder stamped onto the graph input
   * (`generateInput.workflow`), so this is the class that was actually billed,
   * not a re-derivation that could disagree with it.
   *
   * Typed `unknown` because that is how it reads off the graph input record.
   * Omitted / unrecognised → the value degrades to the bare coarse key
   * `textToImage`, never to a guessed variant.
   */
  imageWorkflowType?: unknown;
};

/**
 * Resolve the generation type from a submitted workflow body.
 *
 * 🔴 TOTAL AND NON-THROWING BY CONTRACT. Every caller is on the fire-and-forget
 * spend-attribution path, which is fail-open by design: a resolution failure
 * must degrade to a NULL column exactly the way `sharedContentKey` /
 * `contentAuthorUserId` resolution degrades, never become a new way for the
 * spend path to throw. So this takes `unknown` and returns `null` for anything
 * it cannot type — a malformed body, a `kind` this build does not know, or a
 * `step` id that is not registered here.
 *
 * NULL is a real, expected value. A row whose type could not be resolved is
 * better left untyped than stamped with a guess: a wrong type is worse than a
 * missing one, because a missing one is visibly missing.
 *
 * 🔴 AND THE SAME RULE ONE LEVEL DOWN, WHICH IS WHAT THE SUBTYPE AXIS ADDS: an
 * unresolvable SUB-axis degrades to the bare COARSE key rather than to `null` or
 * to a guess. The coarse key is independently certain (it is the body's own
 * discriminant) and it is what the per-generation-type fee looks up, so
 * discarding it would lose a fact that is not in doubt.
 */
export function resolveBlockGenerationType(
  body: unknown,
  context?: BlockGenerationTypeContext
): BlockGenerationType | null {
  if (typeof body !== 'object' || body === null) return null;

  const kind = (body as { kind?: unknown }).kind;

  if (kind === 'textToImage') {
    return composeBlockGenerationType(kind, imageGenerationSubtype(context?.imageWorkflowType));
  }

  if (kind === 'customComfy') {
    return composeBlockGenerationType(kind, customComfyGenerationSubtype(body));
  }

  if (kind === 'step') {
    // The registered STEP ID — the app-facing wire commitment — never the
    // entry's `orchestratorType`. See the header note; this is the one place
    // the distinction is decided.
    //
    // Checked against `REGISTERED_STEP_IDS` and NOT the wider
    // `isBlockGenerationType`: the wide test would accept
    // `{ kind: 'step', step: 'textToImage' }` and stamp the row `textToImage`,
    // reporting a step submit as an image generation. The wire schema rejects
    // that body, so this is defense in depth — but it is exactly the direction
    // in which a wrong value is worse than a null one.
    const step = (body as { step?: unknown }).step;
    return typeof step === 'string' && (REGISTERED_STEP_IDS as readonly string[]).includes(step)
      ? (step as BlockGenerationType)
      : null;
  }

  return null;
}

/**
 * The COARSE key of a persisted value — everything before the first colon.
 *
 * 🔴 THE DECOMPOSITION RULE, EXPORTED SO THERE IS ONE COPY OF IT. The
 * (unbuilt) per-generation-type author fee keys on this, and it must keep
 * working unchanged as the subtype axis grows. Exported rather than left for
 * each reader to open-code `split(':')[0]`, which is the shape that regenerates
 * the same bug at every call site.
 *
 * Returns `null` for a value this build does not recognise, so a caller cannot
 * key a fee on a string that was never a generation type.
 */
export function blockGenerationCoarseType(value: unknown): string | null {
  if (!isBlockGenerationType(value)) return null;
  const firstColon = value.indexOf(':');
  return firstColon === -1 ? value : value.slice(0, firstColon);
}
