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
//   coarse  ::= "textToImage" | "customComfy" | "step" | <registered step id>
//   subtype ::= a COLON-FREE token, from the closed set that coarse key allows —
//               EXCEPT under "step", whose subtype axis is OPEN and bounded by
//               SHAPE instead (see THE ONE OPEN AXIS below)
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
//   step:<orchestrator $type>
//
// A bare `textToImage` / `customComfy` / `step` is still a legal value: it is
// what a submit degrades to when the sub-axis cannot be established (see
// RESOLUTION below). It is shallower, never wrong.
//
// ── THE ONE OPEN AXIS: `step:<orchestrator $type>` ──────────────────────────
//
// 🔴 EVERY OTHER SUBTYPE COMES FROM A SERVER-OWNED CLOSED SET. THIS ONE DOES
// NOT — IT IS CALLER-SUPPLIED, AND THAT IS THE FACT TO CARRY INTO ANY READING OF
// THIS COLUMN. `kind: 'step'` has TWO arms (see `blockStepMemberSchema` in
// `workflow.schema`): the REGISTRY arm names a server-registered capability by id
// (`convert-image`), and the PASS-THROUGH arm names an ORCHESTRATOR `$type`
// directly and forwards `input` unmodified. On the pass-through arm the `$type` is
// validated against nothing but `PLATFORM_INTERNAL_STEP_TYPES` — no per-type
// schema, no registry — so the token this file interpolates is a string an
// untrusted iframe chose. It is bounded by SHAPE here
// (`BLOCK_PASS_THROUGH_SUBTYPE_PATTERN`) and by nothing else, and a value that
// fails that shape DEGRADES to the bare `step` rather than being refused: the
// write is fire-and-forget off an already-billed submit and must never throw.
//
// 🔴 WHY IT IS NAMESPACED UNDER `step:` RATHER THAN RECORDED BARE, and this is
// the load-bearing half of the design: `textToImage` and `customComfy` are
// THEMSELVES real orchestrator `$type` keys (measured 2026-09-17 against
// `WorkflowStepTemplate.discriminator.mapping` — 50 keys, both present, along with
// `imageGen`, `convertImage` and `chatCompletion`). So a BARE `$type` would stamp
// `{kind:'step', $type:'textToImage'}` as `generationType: 'textToImage'` —
// indistinguishable from a genuine `kind:'textToImage'` submit and PRICED AS ONE
// by the per-generation-type fee. That is the same hazard the step arm's own
// resolution note names ("reporting a step submit as an image generation …
// exactly the direction in which a wrong value is worse than a null one"), and
// the namespace is what makes it unrepresentable: the coarse key of a
// pass-through row is always `step`, never a kind key and never a registry id.
//
// 🔴 THE VALUE IS AN UPSTREAM SPELLING, DELIBERATELY. It breaks the
// APP-FACING-ID-NEVER-ORCHESTRATOR-`$type` rule below — and it has to, because
// the pass-through arm HAS no app-facing id: the `$type` IS the wire contract the
// app wrote. The `step:` prefix is what keeps that visible in the value itself,
// so a reader can never mistake an orchestrator spelling for a registry id. An
// orchestrator rename therefore splits one capability into two values in this
// column; that is the honest record of what the app actually submitted.
//
// 🔴 AND IT CANNOT BE BOUNDED AGAINST A KNOWN SET. There is no vendored `$type`
// catalog in this repo — only the 15-entry `PLATFORM_INTERNAL_STEP_TYPES`
// denylist and the 2-entry step registry — and the live mapping gained three
// types in six weeks, so a membership test here would either need a catalog
// nobody maintains or would degrade every new upstream type to a bare `step`.
// Shape is the only bound available, which is why it is stated as one.
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
// collides with `textToImage` / `customComfy` / `step`. ⚠️ NOTHING ENFORCES THAT
// IN THE REGISTRY: its load-time invariants pin `step.id === <registry key>` and
// uniqueness of `orchestratorType`, but none of them knows these three strings
// exist. Today the sets are disjoint (measured: the registry holds
// `convert-image` and `chat-completion`); a `step` entry would be the sharpest
// collision of the three, because a bare `step` value would then mean EITHER "a
// pass-through submit whose `$type` was unusable" OR "the registered step named
// `step`". `generation-type.test.ts` turns all three into a red test rather than
// an ambiguous column, and registering a step is a reviewed PR besides.
//
// ⚠️ The `step:` namespace does NOT collide with a registry id in the value
// space, and that is the point of it: `step:convert-image` (a pass-through submit
// naming that `$type`) and `convert-image` (the registry arm) are different
// values with different coarse keys, so the fee cannot conflate them.
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
 * The COARSE key for the PASS-THROUGH `kind: 'step'` arm — the wire `kind`
 * itself, because that arm has no registry id to use instead.
 *
 * 🔴 IT IS ALSO THE NAMESPACE THAT KEEPS A CALLER-SUPPLIED `$type` OUT OF THE
 * KIND-KEY AND REGISTRY-ID NAMESPACES. See THE ONE OPEN AXIS in the header: both
 * `textToImage` and `customComfy` are real orchestrator `$type`s, so a bare
 * `$type` in this column would be priced as an image generation.
 */
export const BLOCK_PASS_THROUGH_COARSE_TYPE = 'step';

/**
 * The wire `kind`s that are their own coarse generation type.
 *
 * Kept as a literal tuple (rather than derived from the zod union) because these
 * are wire discriminants: a rename is a breaking change that must be made
 * deliberately, and this list is what a reader diffs against.
 *
 * 🔴 `step` IS IN HERE, AND THAT MEMBERSHIP IS LOAD-BEARING TWICE OVER — it is
 * not a tidy grouping. It is what makes a bare `step` a legal (degraded) stored
 * value, and it is what puts `step` inside the reach of the registry-collision
 * guard in `generation-type.test.ts`, which loops this tuple against
 * `REGISTERED_STEP_IDS`. Take it out and a step registered as `step` becomes an
 * ambiguous column with nothing red.
 */
export const BLOCK_WORKFLOW_KIND_GENERATION_TYPES = [
  'textToImage',
  'customComfy',
  BLOCK_PASS_THROUGH_COARSE_TYPE,
] as const;

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

/**
 * Max characters of a pass-through SUBTYPE — i.e. of the submitted `$type`.
 *
 * 🔴 MUST EQUAL the wire bound `PASS_THROUGH_TYPE_MAX_CHARS` in
 * `~/server/schema/blocks/workflow.schema`, and it is a LITERAL here rather than
 * an import for the same reason `IMAGE_SUBTYPE_BY_WORKFLOW`'s left side is: this
 * module is pulled in by `buzz-attribution.service` on the fire-and-forget spend
 * path and must stay import-light, while `workflow.schema` pulls in zod and the
 * whole block wire surface. `generation-type.test.ts` imports both and pins them
 * equal in BOTH directions — a wire cap that grows past this one would silently
 * degrade every long `$type` to a bare `step`, which is a depth loss no error
 * reports.
 */
export const BLOCK_PASS_THROUGH_SUBTYPE_MAX_CHARS = 64;

/**
 * The SHAPE bound on a pass-through subtype — the only bound available on the one
 * open axis (see THE ONE OPEN AXIS in the header for why there cannot be a
 * membership one).
 *
 * 🔴 ONE EXPRESSION, THREE PROPERTIES, DELIBERATELY NOT THREE CHECKS. It pins
 * NON-EMPTY (`{1,`), LENGTH-CAPPED (`,N}`) and COLON-FREE plus
 * whitespace/control/unicode-free (the character class). Written as three separate
 * clauses, the non-empty one would be unkillable — a `{1,N}` quantifier already
 * refuses `''` — and this file's own note on `isBlockGenerationType` explains why
 * a guard no test can turn red is worse than none. Each property is instead
 * killable through this one expression: drop the anchors and `step:a:b` is
 * accepted; drop the `{1,N}` and a 65-char `$type` is; widen the class and
 * `step:a b` is. `generation-type.test.ts` asserts all three.
 *
 * 🔴 THE COLON-FREE PROPERTY IS STRUCTURAL AGAIN, not a separate guard: `:` is
 * not in the class, so the at-most-one-colon rule of THE VALUE GRAMMAR holds on
 * this arm exactly the way it holds on the closed ones (every allowed subtype is
 * colon-free). This is the one place that is true by a character class rather
 * than by a set's contents.
 *
 * 🔴 THE CLASS IS NOT A GUESS: all 50 `$type` keys of the live
 * `WorkflowStepTemplate.discriminator.mapping` match it (measured 2026-09-17; 50
 * of 50, longest 22 chars), so no legitimate submit loses its subtype to this
 * bound. The wire schema is far laxer — `z.string().min(1).max(64)` admits
 * `a:b`, `foo bar`, a newline — so the degrade path is REACHABLE from the wire,
 * not hypothetical, and `generation-type.test.ts` proves that by parsing such a
 * body with the real schema.
 *
 * ⚠️ IT DOES NOT MAKE THE SUBTYPE TRUSTWORTHY, and nothing here should be read as
 * claiming that. `step:toString` is an ACCEPTED value (a legal `$type` string as
 * far as this repo is concerned) — harmless because nothing indexes an object by
 * this segment and the fee keys on the coarse `step`, but it is why the
 * prototype-key discipline documented on `isBlockGenerationType` is about
 * LOOKUPS, not about this shape test.
 */
const BLOCK_PASS_THROUGH_SUBTYPE_PATTERN = new RegExp(
  `^[A-Za-z0-9._-]{1,${BLOCK_PASS_THROUGH_SUBTYPE_MAX_CHARS}}$`
);

/** True iff `subtype` is a shape-valid pass-through subtype. Total, non-throwing. */
export function isBlockPassThroughSubtype(subtype: string): boolean {
  return BLOCK_PASS_THROUGH_SUBTYPE_PATTERN.test(subtype);
}

export type BlockGenerationType =
  | 'textToImage'
  | `textToImage:${BlockImageGenerationSubtype}`
  | 'customComfy'
  | `customComfy:${RegisteredRecipeId | typeof CUSTOM_COMFY_INLINE_SUBTYPE}`
  // 🔴 THE OPEN ARM. `${string}` because the subtype is a caller-supplied
  // orchestrator `$type` bounded by SHAPE, not by membership — a template literal
  // type cannot express "matches this regex", so the TYPE is wider than the
  // runtime bound and `isBlockGenerationType` is the only complete statement of
  // what is legal. That asymmetry is the reason the write-side re-check in
  // `buzz-attribution.service` is not redundant with this type.
  | typeof BLOCK_PASS_THROUGH_COARSE_TYPE
  | `${typeof BLOCK_PASS_THROUGH_COARSE_TYPE}:${string}`
  | (typeof REGISTERED_STEP_IDS)[number];

/**
 * Sentinel for a coarse key whose subtype axis is OPEN — bounded by SHAPE
 * (`isBlockPassThroughSubtype`) instead of by membership.
 *
 * 🔴 A SENTINEL RATHER THAN A RETURNED SET, SO THE OPEN AXIS CANNOT LOOK CLOSED.
 * The obvious alternative — have `blockGenerationSubtypeRule` keep returning
 * `readonly string[]` and special-case `step` at the call site — puts the "this
 * key is open" fact in two places and makes the function's own answer for `step`
 * (an empty set, i.e. "no subtype is ever allowed") a lie that reads as a bound.
 */
const OPEN_SUBTYPE_AXIS = Symbol('OPEN_SUBTYPE_AXIS');

/**
 * What subtypes a given COARSE key allows — the ONE place that policy lives.
 *
 * A closed set for the two `kind` keys. `OPEN_SUBTYPE_AXIS` for the pass-through
 * key, whose subtype is a caller-supplied `$type` (see THE ONE OPEN AXIS).
 *
 * A registered step id gets the EMPTY set, not a wildcard and not the open
 * sentinel: a step carries no subtype today, so `convert-image:anything` must be
 * refused rather than waved through as "some future step subtype".
 */
function blockGenerationSubtypeRule(coarse: string): readonly string[] | typeof OPEN_SUBTYPE_AXIS {
  if (coarse === 'textToImage') return BLOCK_IMAGE_GENERATION_SUBTYPES;
  if (coarse === 'customComfy') return CUSTOM_COMFY_GENERATION_SUBTYPES;
  if (coarse === BLOCK_PASS_THROUGH_COARSE_TYPE) return OPEN_SUBTYPE_AXIS;
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
 *
 * 🔴 "THE WHOLE POPULATION" IS NOW THE CLOSED POPULATION ONLY, AND THE GAP IS
 * DELIBERATE — READ THIS BEFORE ADDING TO THE LEDGER. The `step:<$type>` arm is
 * open by construction (the subtype is a caller-supplied orchestrator `$type`
 * bounded by shape), so it has no finite enumeration to put here: the bare
 * `step` coarse key is in this list and NO `step:` value ever is. That is not an
 * omission to be fixed by inventing a sample — a sampled `step:` entry would make
 * the ledger read as complete while covering an infinite set, which is worse than
 * a stated gap. `generation-type.test.ts` asserts the exclusion EXPLICITLY (no
 * member starts with `step:`, while the resolver demonstrably emits values that
 * the bound accepts and this ledger does not contain), so the decision is pinned
 * rather than inferred from a missing line.
 *
 * The consequence to keep in mind when reading a test over this list: for the
 * closed arms it is still bidirectional, but "the ledger covers everything the
 * resolver can emit" is FALSE by design, and only the open arm is exempt.
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
 *     through as "some future step subtype");
 *   - 🔴 EXCEPT under the ONE OPEN COARSE KEY, `step`, where the subtype is a
 *     caller-supplied orchestrator `$type` and the membership test is replaced by
 *     `isBlockPassThroughSubtype` — a shape test, not a weaker membership test.
 *     It is still non-empty, still colon-free (a colon is not in its character
 *     class) and additionally length-capped, so THE VALUE GRAMMAR holds on this
 *     arm too. What it does NOT do is bound the subtype to anything this repo
 *     knows; see THE ONE OPEN AXIS in the header for why no such set exists.
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

  // 🔴 ONE RULE PER COARSE KEY, NOT FOUR CHECKS — AND THE MISSING THREE ARE A
  // DELIBERATE DELETION, NOT AN OVERSIGHT. Separate checks for "the coarse key is
  // known", "at most one colon" and "the subtype is non-empty" were all written,
  // and a mutation sweep proved NONE of them could be turned red: the rule lookup
  // returns the EMPTY set for an unknown coarse key, and every member of every
  // closed set is colon-free and non-empty, so the membership line below already
  // refuses `videoToVideo:txt2img`, `textToImage:img2img:edit` and
  // `textToImage:`. A guard no test can turn red is worse than no guard — it
  // reads as coverage while providing none, which is how a reviewer is talked out
  // of looking.
  //
  // So the whole bound on the composite half is ONE rule in ONE place: whatever
  // `blockGenerationSubtypeRule` says this coarse key allows. The one way a closed
  // set could ever admit a colon is a REGISTRY ID containing one (recipe ids are
  // interpolated verbatim). That is pinned at REGISTRATION time by the "no
  // registry id contains a colon" invariant guard in `generation-type.test.ts` —
  // where a new entry trips it — rather than here at runtime, where the value
  // would already have been written.
  //
  // 🔴 THE SECOND BRANCH IS THE OPEN AXIS, AND IT IS THE ONLY THING THAT ADMITS A
  // `step:` VALUE — delete it and `step:imageGen` is refused, which is what makes
  // it killable rather than decorative. It replaces the membership test with the
  // shape test for exactly one coarse key; the closed keys are untouched, so a
  // value under them cannot reach the shape test and be waved through by it.
  const rule = blockGenerationSubtypeRule(value.slice(0, firstColon));
  const subtype = value.slice(firstColon + 1);
  return rule === OPEN_SUBTYPE_AXIS ? isBlockPassThroughSubtype(subtype) : rule.includes(subtype);
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
 * it cannot type — a malformed body, a `kind` this build does not know, a
 * `step` id that is not registered here, or a `kind: 'step'` body that matches
 * NEITHER arm (no registry id and no string `$type`).
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
    const step = (body as { step?: unknown }).step;

    // 🔴 `kind: 'step'` HAS TWO ARMS AND `step === undefined` IS THE
    // DISCRIMINATOR, not a missing field. `blockStepMemberSchema` nests a
    // discriminated union on `step` itself, where the PASS-THROUGH arm declares
    // `step: z.undefined()` — so a body reaching here with no `step` is the
    // pass-through arm, carrying an orchestrator `$type` instead of a registry id.
    // Before this arm existed here, every pass-through generation recorded NULL:
    // the registry check below cannot match `undefined`, and `null` is a
    // legitimate return for an unknown body, so nothing looked wrong.
    if (step === undefined) {
      const passThroughType = (body as { $type?: unknown }).$type;
      // A body with neither `step` NOR a string `$type` is not a pass-through
      // body this build can type — `null`, not a bare `step`. That keeps the
      // contract above ("a `kind` this build does not know → null") true for
      // junk like `{ kind: 'step', params: {} }`, which matches NEITHER arm of
      // the wire schema and must not be recorded as a pass-through submit.
      if (typeof passThroughType !== 'string') return null;
      // NAMESPACED, and routed through the one constructor so the shape bound and
      // the write-side re-check cannot disagree. An unusable `$type` (colon-
      // bearing, over-long, whitespace — all of which the wire schema permits)
      // degrades to the bare `step`, never to a raw value and never to a throw.
      return composeBlockGenerationType(BLOCK_PASS_THROUGH_COARSE_TYPE, passThroughType);
    }

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
