import { REGISTERED_STEP_IDS } from './steps';

// ─────────────────────────────────────────────────────────────────────────────
// App Blocks GENERATION TYPE — the app-facing key for "what kind of generation
// was this", resolved from a submitted `BlockWorkflowBody` and persisted on the
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
// 🔴 THE VALUE IS THE APP-FACING ID, NEVER THE ORCHESTRATOR `$type`. For
// `kind: 'textToImage'` / `kind: 'customComfy'` it is the `kind` itself; for
// `kind: 'step'` it is the REGISTERED STEP ID (`convert-image`,
// `chat-completion`) — the id the registry calls "a permanent public wire
// commitment" — and NOT the entry's `orchestratorType` (`convertImage`,
// `chatCompletion`), which is the orchestrator's own internal spelling and is
// free to change without a wire-contract decision. The two are one refactor
// apart from disagreeing, and the durable column must follow the stable one.
//
// A step id implies `kind: 'step'`, so ONE column is enough — no companion
// `kind` column. That reading holds as long as no registered step id collides
// with `textToImage` / `customComfy`. ⚠️ NOTHING ENFORCES THAT: the registry's
// load-time invariants pin `step.id === <registry key>` and uniqueness of
// `orchestratorType`, but neither knows these two strings exist. Today the two
// sets are disjoint; if a future entry were registered under one of those names
// the column would become ambiguous, so it is called out here rather than
// assumed. Registering a step is a reviewed PR, which is where that is caught.
//
// 🔴 NO DB CHECK CONSTRAINT / NO ENUM. The step registry is explicitly designed
// to grow ADDITIVELY — "future step types must be ADDITIVE (register an entry)
// rather than a schema change" — and a CHECK would turn every new registered
// step into a database migration, defeating that. The bound is enforced HERE,
// in code, against the same registry the wire schema derives its enum from.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two non-registry `kind`s, which are their own generation type. Kept as a
 * literal tuple (rather than derived from the zod union) because these are wire
 * discriminants: a rename is a breaking change that must be made deliberately,
 * and this list is what a reader diffs against.
 */
export const BLOCK_WORKFLOW_KIND_GENERATION_TYPES = ['textToImage', 'customComfy'] as const;

export type BlockGenerationType =
  | (typeof BLOCK_WORKFLOW_KIND_GENERATION_TYPES)[number]
  | (typeof REGISTERED_STEP_IDS)[number];

/**
 * Every generation type that can currently be persisted: the two kinds plus
 * every registered step id. DERIVED from the registry, so registering a step
 * widens this automatically and no second list can drift out of sync.
 */
export const BLOCK_GENERATION_TYPES: readonly BlockGenerationType[] = [
  ...BLOCK_WORKFLOW_KIND_GENERATION_TYPES,
  ...REGISTERED_STEP_IDS,
];

/**
 * Is `value` a generation type this build knows how to persist?
 *
 * 🔴 An ARRAY membership test, deliberately — not a lookup into the registry
 * object. `getStep(id)` indexes a plain object literal, so `getStep('toString')`
 * returns `Function.prototype.toString` (truthy) and a prototype key would sail
 * through a `getStep(x) ? x : null` guard and land in the column. An
 * `Array.includes` over the derived id list has no prototype to fall through to.
 */
export function isBlockGenerationType(value: unknown): value is BlockGenerationType {
  return typeof value === 'string' && (BLOCK_GENERATION_TYPES as readonly string[]).includes(value);
}

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
 */
export function resolveBlockGenerationType(body: unknown): BlockGenerationType | null {
  if (typeof body !== 'object' || body === null) return null;

  const kind = (body as { kind?: unknown }).kind;

  if (kind === 'textToImage' || kind === 'customComfy') return kind;

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
