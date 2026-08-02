/**
 * SILENT MODEL SUBSTITUTION — the record side (issue #3520, phase 1).
 *
 * WHAT IS BEING OBSERVED
 * ----------------------
 * On a `modelLocked` ecosystem, `createCheckpointGraph`'s `checkpointInputSchema`
 * (see `common.ts`) replaces any checkpoint version id that is not in the current
 * workflow's visible list with that workflow's `defaultModelId`. The parse
 * SUCCEEDS, images come back, the user is billed — and nothing in the response
 * says a different model ran.
 *
 * That is deliberate, correct graceful degradation for the ON-SITE generator:
 * the only way the form holds an out-of-list id is a stale `localStorage` value
 * after an ecosystem switch, and the user visibly sees the picker snap back. It
 * became a problem when the same graph went API-driven through the App Blocks
 * bridge, where the id IS deliberate (an app author wrote it) and the correction
 * is unobservable.
 *
 * 🔴 THIS MODULE CHANGES NO BEHAVIOUR. It records that the substitution happened
 * so the swap is detectable and countable. Which model actually runs is
 * identical before and after — deciding whether any case should REJECT is a
 * later phase, gated on what the counter measures.
 *
 * WHY A SIDE CHANNEL AND NOT A MARKER ON THE VALUE
 * ------------------------------------------------
 * The obvious implementation — returning `{ id, model, __substitution }` from
 * the clamp — is INERT, and quietly so. The model node's `output` is
 * `resourceSchema.optional()`, and `resourceSchema` is a plain `z.object()`,
 * which STRIPS unknown keys (zod 4.0.17). The marker would be silently dropped:
 * the code compiles, a unit test against the input transform passes, and nothing
 * is observed. Verified by execution, with `z.looseObject` (marker survives) and
 * a declared key (survives) as controls. So the record travels on the CONTEXT,
 * not on the parsed value.
 *
 * 🔴 WHY THE COLLECTOR IS PER-REQUEST. It is attached to the fresh `externalCtx`
 * object literal `buildGenerationContext` constructs on every call. It must
 * NEVER be hung off anything reachable from that function's awaited inputs
 * (`getGenerationStatus`, `getGenerationEcosystemConfig`, `getGateRules`) — those
 * read process/redis-level caches, and a mutable array behind one of them would
 * accumulate substitutions ACROSS USERS and then report one user's requested
 * model id to another.
 *
 * 🔴 WHY THE CLASSIFIER IS INJECTED rather than imported. Classifying the reason
 * means asking the real graph config which workflow a version belongs to, i.e.
 * `resolveVersionWorkflowScope` in `workflow-capability.ts` — which imports
 * `generation-graph.ts`. A static import of that from `common.ts` creates a
 * module cycle that is FATAL in one direction: measured, importing `common.ts`
 * first crashes at module-eval with `TypeError: Cannot read properties of
 * undefined (reading 'entries')` in `DataGraph.merge` (the ecosystem graphs run
 * their top-level `createCheckpointGraph(...)` against a half-initialised
 * `common` namespace). Importing `generation-graph.ts` first happens to work,
 * which is exactly what makes the cycle dangerous. Injection removes the edge
 * entirely: this module imports nothing from the graph, and the server hands in
 * the classifier at collector-construction time.
 */

/**
 * Why the graph substituted a different checkpoint version than the caller sent.
 *
 * 🔴 DECLARED ONCE, HERE. This union is simultaneously (a) the wire contract on
 * `BlockWorkflowSnapshot.modelSubstitutions[].reason` and (b) one of the two
 * labels of `civitai_generation_model_substitutions_total` (the other being
 * {@link GENERATION_SURFACES}). One declaration is what stops
 * the label set and the contract from drifting: a new cause cannot be recorded
 * without appearing here, and adding one here is a deliberate, reviewable
 * widening of the metric's cardinality. (#3532's app-block metrics declare their
 * union in the metrics module because it originates there; this one originates
 * as a shared wire type, so the direction is reversed and the metrics module
 * imports FROM here. This module still imports nothing at all, so that direction
 * cannot pull prom-client — or any server module — into shared graph code.)
 *
 *  - `wrong-workflow` — the id IS one of this ecosystem's workflow-scoped
 *                       checkpoint versions, but belongs to a DIFFERENT workflow
 *                       (e.g. an edit-only version sent to `txt2img`). The
 *                       caller named a real version for the wrong mode, so there
 *                       is a specific right answer they probably wanted.
 *  - `unrecognized`   — the id is in NO scoped list of this ecosystem: a
 *                       community checkpoint, or a version retired since the app
 *                       shipped. Degrading here is what keeps an app pinned to a
 *                       deprecated version alive instead of hard-failing.
 *  - `gated`          — the id IS offered for THIS workflow by the config, but a
 *                       gate rule applicable to THIS user hid it from the version
 *                       selector. Neither of the two cases the issue names: the
 *                       app is not wrong and the version is not retired — the
 *                       viewer simply may not use it. Kept distinct because the
 *                       operator response differs (an entitlement question, not a
 *                       config or app-authoring one) and folding it into
 *                       `unrecognized` would mislabel it.
 */
export const MODEL_SUBSTITUTION_REASONS = ['wrong-workflow', 'unrecognized', 'gated'] as const;

export type ModelSubstitutionReason = (typeof MODEL_SUBSTITUTION_REASONS)[number];

const MODEL_SUBSTITUTION_REASON_SET: ReadonlySet<string> = new Set(MODEL_SUBSTITUTION_REASONS);

/**
 * Runtime narrowing of a reason. 🔴 The "3 values, forever" guarantee must rest
 * on CODE, not on the type system: `ModelSubstitutionReason` is erased at
 * runtime, so a classifier that returns something else — a refactor that forgets
 * a branch and falls through to `undefined`, a stubbed/mocked classifier, a
 * `.js` caller — would put that value on the wire AND into
 * `inc({ reason: <whatever> })`, which is exactly how an "impossible" label
 * becomes an unbounded series. Only reachable by defeating the types today; the
 * check is one `Set.has` on a path that only runs when a substitution actually
 * happened.
 */
export function isModelSubstitutionReason(value: unknown): value is ModelSubstitutionReason {
  return typeof value === 'string' && MODEL_SUBSTITUTION_REASON_SET.has(value);
}

/**
 * WHICH CALLER's graph validation substituted — the second (and final) label of
 * `civitai_generation_model_substitutions_total`.
 *
 * 🔴 WHY THIS LABEL EXISTS. `validateInput` is the choke point for EVERY
 * server-side `generationGraph.safeParse`, so without it the counter mixes three
 * populations whose meanings are opposite:
 *
 *   - `onsite`  — the on-site generator, where the substitution is the DELIBERATE,
 *                 CORRECT graceful degradation (#3520 defends it: a stale
 *                 localStorage id after an ecosystem switch, and the user visibly
 *                 sees the picker snap back).
 *   - `block`   — the App Blocks bridge, where the id was written by an app author
 *                 and the correction is unobservable. This is the population
 *                 phase 3's policy decision is actually about.
 *   - `preset`  — comics / preset image generation, server-composed input.
 *
 * Phase 2 exists to produce a real incidence number that GATES phase 3. Summing
 * on-site's correct behaviour into the bridge's incorrect behaviour measures a
 * contaminated quantity, so the split is load-bearing, not decoration.
 *
 * 🔴 BOUNDED, AND KEPT THAT WAY: 3 reasons × 3 surfaces = 9 series, total,
 * forever. This is the ONLY dimension added; version id / ecosystem / workflow /
 * app id / user id are all caller-controlled or high-cardinality and stay out
 * (prom-client retains every distinct label set in the Node heap forever, across
 * ~130 scraped pods). Attribution belongs in the snapshot the caller already
 * receives.
 */
export const GENERATION_SURFACES = ['block', 'onsite', 'preset'] as const;

export type GenerationSurface = (typeof GENERATION_SURFACES)[number];

const GENERATION_SURFACE_SET: ReadonlySet<string> = new Set(GENERATION_SURFACES);

/** Runtime narrowing of a surface — same reasoning as {@link isModelSubstitutionReason}. */
export function isGenerationSurface(value: unknown): value is GenerationSurface {
  return typeof value === 'string' && GENERATION_SURFACE_SET.has(value);
}

/** One recorded silent checkpoint substitution. */
export type ModelSubstitution = {
  /** The checkpoint version id the caller actually sent. */
  requested: number;
  /** The version id the graph ran instead (the workflow's `defaultModelId`). */
  applied: number;
  reason: ModelSubstitutionReason;
  /** Ecosystem key the parse resolved to, e.g. `'Qwen'`. */
  ecosystem: string;
  /** Workflow key the parse resolved to, e.g. `'txt2img'`. */
  workflow: string;
};

/** The facts the clamp knows at the moment it substitutes. */
export type ModelSubstitutionEvent = Omit<ModelSubstitution, 'reason'>;

/**
 * Resolves the REASON for one substitution. Server-supplied (see the module
 * note on why this is injected); `classifyModelSubstitutionReason` in
 * `workflow-capability.ts` is the only implementation.
 */
export type ModelSubstitutionClassifier = (
  event: ModelSubstitutionEvent
) => ModelSubstitutionReason;

export type ModelSubstitutionCollector = {
  /**
   * WHICH surface's validation this collector belongs to — fixed at construction
   * by the caller that built the request's `GenerationCtx`, never inferred at the
   * clamp. See {@link GenerationSurface}.
   */
  readonly surface: GenerationSurface;
  /**
   * Record one substitution. WRITE-ONCE per
   * `(workflow, ecosystem, requested, applied)`: a zod `.transform()` is not
   * contractually single-shot, and a repeat parse of the same context must not
   * inflate the metric or duplicate the snapshot entry. (Measured on the real
   * path: the clamp runs exactly ONCE per `generationGraph.safeParse` today —
   * the dedupe is the guarantee, not the observation.)
   *
   * Never throws: an observability failure must not break a parse that would
   * otherwise have succeeded.
   */
  record(event: ModelSubstitutionEvent): void;
  /** Everything recorded on this request, in first-seen order. */
  list(): ModelSubstitution[];
  /**
   * Records not yet handed out for metric emission, marking them emitted.
   * Idempotent by construction: a second call returns `[]`, so a code path that
   * drains twice cannot double-count.
   */
  takeUnemitted(): ModelSubstitution[];
};

function keyOf(event: ModelSubstitutionEvent): string {
  return `${event.workflow}|${event.ecosystem}|${event.requested}|${event.applied}`;
}

/**
 * Build a fresh per-request collector. 🔴 Call this per request and attach the
 * result to a freshly constructed context object — see the module note.
 *
 * `surface` names the caller (block / onsite / preset) and becomes the second
 * label on the counter. It is supplied by whoever builds the request context —
 * never guessed from the parse — because `validateInput` is shared by all three
 * and cannot tell them apart.
 */
export function createModelSubstitutionCollector(
  classify: ModelSubstitutionClassifier,
  surface: GenerationSurface
): ModelSubstitutionCollector {
  const records: ModelSubstitution[] = [];
  const seen = new Set<string>();
  let emitted = 0;

  return {
    surface,
    record(event) {
      try {
        const key = keyOf(event);
        if (seen.has(key)) return;
        const reason = classify(event);
        // 🔴 RUNTIME narrowing, not a type assertion. An unknown reason is
        // DROPPED rather than recorded: letting it through would put an
        // unbounded, caller-shaped value on the wire contract AND into the
        // counter's label set. Dropping loses one observation of an event that
        // is already only reachable by defeating the types; admitting it would
        // lose the cardinality bound permanently.
        if (!isModelSubstitutionReason(reason)) return;
        records.push({ ...event, reason });
        // 🔴 AFTER the successful push, not before. `seen` is the write-once
        // dedupe; marking the key before `classify` could throw meant a
        // classifier that threw on its first call PERMANENTLY dropped that key
        // for the whole request — the catch below swallowed the throw, nothing
        // was recorded, and the retry short-circuited on `seen.has(key)`
        // (measured: classifyCalls === 1, `list()` stayed `[]`). Harmless with
        // today's pure classifier; free to make correct.
        seen.add(key);
      } catch {
        /* observability must never break the parse it observes */
      }
    },
    list() {
      return records.slice();
    },
    takeUnemitted() {
      const pending = records.slice(emitted);
      emitted = records.length;
      return pending;
    },
  };
}
