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
 * `BlockWorkflowSnapshot.modelSubstitutions[].reason` and (b) the ONLY label of
 * `civitai_generation_model_substitutions_total`. One declaration is what stops
 * the label set and the contract from drifting: a new cause cannot be recorded
 * without appearing here, and adding one here is a deliberate, reviewable
 * widening of the metric's cardinality. (#3532's app-block metrics declare their
 * union in the metrics module because it originates there; this one originates
 * as a shared wire type, so the direction is reversed and the metrics module
 * imports it TYPE-ONLY — nothing pulls prom-client into shared graph code.)
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
 */
export function createModelSubstitutionCollector(
  classify: ModelSubstitutionClassifier
): ModelSubstitutionCollector {
  const records: ModelSubstitution[] = [];
  const seen = new Set<string>();
  let emitted = 0;

  return {
    record(event) {
      try {
        const key = keyOf(event);
        if (seen.has(key)) return;
        seen.add(key);
        records.push({ ...event, reason: classify(event) });
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
