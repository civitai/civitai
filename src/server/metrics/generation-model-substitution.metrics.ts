// Silent checkpoint SUBSTITUTION counter (issue #3520, phase 1).
//
// On a `modelLocked` ecosystem the generation graph replaces a checkpoint
// version id that is not in the current workflow's visible list with that
// workflow's `defaultModelId`, returns success, and bills the user — with
// nothing in the response, the snapshot, or the `block_workflows` read-model
// saying a different model ran. The behaviour is deliberate and is NOT changed
// by this counter; the counter exists because the swap is otherwise
// unmeasurable, and every later decision about it (reject `wrong-workflow`?
// keep degrading `unrecognized`?) needs a real traffic number first.
//
// Emitted from `validateInput` in orchestration-new.service — the single choke
// point through which every SERVER-side `generationGraph.safeParse` runs
// (on-site submit, whatIf, and the App Blocks bridge alike). The in-browser form
// parse never reaches here: only the server attaches a substitution collector.
//
// 🔴 WHAT ONE INCREMENT MEANS: one GRAPH VALIDATION that substituted — NOT one
// user-visible generation, and NOT a fixed multiple of one either. The ratio of
// increments to user-visible generations is VARIABLE, and the variance is not
// small. On the `block` surface, for ONE user-visible generation:
//
//   • 2   — the normal successful submit (whatIf cost preflight, then the real
//           submit; each builds its own per-request collector).
//   • 1   — when the whatIf estimate exceeds the block's per-call buzz budget:
//           `blocks.router.ts` returns the insufficient-budget snapshot BEFORE
//           the idempotency claim and the real submit, so only the preflight ran.
//   • +1  — per `blocks.estimateWorkflow` call the block chooses to make. That
//           is a separate procedure a block may call any number of times (a live
//           cost readout as the user types), so this term is UNBOUNDED.
//   • +1  — per idempotency REPLAY that re-enters the procedure (a retried
//           submit re-runs the preflight before the claim short-circuits).
//
// So: read this as a RATE and a TREND per surface. It is NOT a headcount of
// affected generations, and dividing by 2 does NOT produce one. A real
// "generations served the wrong model" figure has to come from the snapshot/log
// side (where each record is tied to one workflow id), not from here.
//
// 🔴 ALERTING: use `max_over_time(...[window])`, NOT `rate()`. This is a RARE
// per-pod counter across ~130 pods: a pod that substitutes once creates its
// labelled child at 1 and never increments it again, so `rate()`/`increase()`
// over that child is structurally 0 and an alert keyed on it silently never
// fires — the counter looks healthy precisely because the event is rare, which
// is the failure mode this signal exists to prevent.
//
// prom-client GOTCHA (same as ~/server/metrics/app-block-runtime.metrics.ts):
// Next.js can import a module twice (hot reload / route bundling) and prom-client
// throws if a metric name is registered twice, so the getter below is a
// get-or-create guard against the DEFAULT global registry.
//
// 🔴 SURFACE, and why it is not optional. `validateInput` is shared by the
// on-site generator, bearer-token API callers (#3665), the App Blocks bridge,
// and comics/preset generation. #3520
// defends the on-site substitution as CORRECT (a stale localStorage id after an
// ecosystem switch, visibly corrected in the picker) and indicts the bridge one
// as unobservable — opposite verdicts, and without a `surface` label they land
// in the same series. Phase 2's job is to produce a real incidence number that
// gates phase 3's policy decision; summed across surfaces that number measures a
// contaminated quantity. The label is supplied BY THE CALLER at context-build
// time (`buildGenerationContext(..., surface)`), never inferred here.
//
// 🔴 CARDINALITY: exactly two labels, each over a code-owned union declared once
// in `model-substitution.ts` → 3 reasons × 4 surfaces = 12 series, TOTAL.
// (Was 9; #3665 split `api` out of `onsite`, which had been assigned by a
// hardcoded literal on two tRPC procedures that also serve bearer-token callers.
// Widening the union is deliberate and gated by tests on both unions.)
// Deliberately NO version id, model id, ecosystem, workflow, app id, or
// user id: this fires once per substituted parse with nothing caching it, the
// requested version id is caller-controlled and effectively unbounded, and
// prom-client retains every distinct label set in the Node heap forever (the
// --max-old-space-size exit-139 OOM class) across ~130 scraped pods. Attribution
// belongs in the snapshot the caller already receives (which carries the exact
// requested/applied ids) — alert on the metric, attribute from the snapshot.
// Both label values are NARROWED AT RUNTIME before `inc()` so the bound rests on
// code rather than on erased types.
import client, { type Counter, type Registry } from 'prom-client';

import {
  GENERATION_SURFACES,
  isGenerationSurface,
  isModelSubstitutionReason,
  MODEL_SUBSTITUTION_REASONS,
  type GenerationSurface,
  type ModelSubstitutionReason,
} from '~/shared/data-graph/generation/model-substitution';

/**
 * Initialise all 12 `(reason, surface)` series to 0 at registration.
 *
 * 🔴 WHY, AND WHY IT IS NOT COSMETIC. prom-client only materialises a child
 * series on its first `inc()`, so before this a pod exposed NOTHING for a
 * surface until that surface substituted on that pod. A PromQL read of
 * `…{surface="api"}` then returns `no data`, which is indistinguishable from
 * "the instrument is not wired" — and this counter exists specifically to be
 * read as a gate. That is the same defect the `api` split was made to fix
 * (#3665: a bucket that reads zero cannot gate a decision); leaving the new
 * bucket unreadable on day 0 would reproduce it one level down. A real zero and
 * an absent series must be distinguishable.
 *
 * Free by construction: 12 series is the counter's whole cardinality budget, so
 * seeding costs exactly what a fully-exercised pod already costs and cannot
 * grow.
 *
 * 🔴 SEEDING ALONE IS NOT ENOUGH, AND AN EARLIER VERSION OF THIS COMMENT SAID
 * IT WAS. It claimed `rate()`/`increase()` become "well-defined from the first
 * scrape". They do not, unless something CALLS this at pod start:
 * `ensureRegister…` has no caller outside this module, and the only production
 * path in is `recordGenerationModelSubstitution`, which by definition runs only
 * once a substitution has already happened. So the metric was absent until the
 * first event on that pod — exactly the ambiguity the seeding exists to remove.
 * The missing half is the side-effect call in `src/pages/api/metrics.ts`
 * (mirroring `~/server/prom/challenge.metrics` two lines above it, which is
 * there for the same reason). Both halves are required; neither works alone.
 *
 * Idempotent — `getOrCreateCounter` returns the EXISTING counter on re-entry and
 * `inc(…, 0)` is a no-op on an already-materialised series, so calling this on
 * every request (which `ensureRegister…` is documented to allow) cannot reset or
 * double-count anything.
 */
function seedAllSeries(counter: Counter<string>): void {
  for (const reason of MODEL_SUBSTITUTION_REASONS) {
    for (const surface of GENERATION_SURFACES) counter.inc({ reason, surface }, 0);
  }
}

function getOrCreateCounter(
  reg: Registry,
  name: string,
  help: string,
  labelNames: string[]
): Counter<string> {
  const existing = reg.getSingleMetric(name) as Counter<string> | undefined;
  if (existing) return existing;
  return new client.Counter({ name, help, labelNames, registers: [reg] });
}

/**
 * Idempotent: safe to call on every request. Returns the counter instance
 * (existing or newly created) from the default registry that /api/metrics
 * scrapes.
 */
export function ensureRegisterGenerationModelSubstitutionMetrics(reg: Registry = client.register): {
  modelSubstitutionsTotal: Counter<string>;
} {
  const modelSubstitutionsTotal = getOrCreateCounter(
    reg,
    'civitai_generation_model_substitutions_total',
    'Server-side generation GRAPH VALIDATIONS in which a modelLocked ecosystem SILENTLY replaced the requested checkpoint version with the workflow default. ' +
      'NOT a count of user-visible generations: the ratio is VARIABLE — a block submit normally validates twice (whatIf preflight + real submit), once if the preflight exceeds the buzz budget, plus one per estimateWorkflow call (unbounded) and one per idempotency replay. Use as a rate/trend per surface; attribute individual cases from the snapshot. ' +
      'reason (wrong-workflow = the version is scoped to a different workflow of the same ecosystem; unrecognized = the version is in no scoped list at all; gated = the version IS offered for this workflow but a gate rule hid it from this user). ' +
      'surface (api = the same two tRPC generation procedures reached with a bearer token — a CLI, script or external integration, where the id was deliberate and nothing reports the correction; block = the App Blocks bridge, where the id was deliberate and the correction was unobservable; onsite = the on-site generator under a COOKIE SESSION, where this substitution is the intended graceful degradation and is visible to the user; preset = comics/preset server-composed generation)',
    ['reason', 'surface']
  );
  seedAllSeries(modelSubstitutionsTotal);
  return { modelSubstitutionsTotal };
}

/**
 * Fail-soft emit of one recorded substitution.
 *
 * 🔴 TOTAL, like every emitter in `app-block-runtime.metrics.ts`. This
 * instruments the GENERATION SUBMIT path: a metrics error (registry collision,
 * label mismatch) must never propagate, or observing a successful degradation
 * would turn it into a failed generation — the observability converting a
 * working request into an outage. The caller guards independently too; the
 * duplication is deliberate, because the guarantee must not rest on either layer
 * alone.
 *
 * COST: one in-heap counter increment, and only on a parse that actually
 * substituted. A submit that names an in-list version never reaches here, so the
 * steady state on healthy traffic is zero emits.
 */
export function recordGenerationModelSubstitution(
  reason: ModelSubstitutionReason,
  surface: GenerationSurface
): void {
  try {
    // 🔴 The cardinality bound rests HERE, on code, not on the erased types
    // above. An unknown reason or surface is DROPPED, not passed through and not
    // relabelled to a plausible default — either would make the "12 series"
    // claim a wish. Reachable today only by defeating the types.
    if (!isModelSubstitutionReason(reason) || !isGenerationSurface(surface)) return;
    const { modelSubstitutionsTotal } = ensureRegisterGenerationModelSubstitutionMetrics();
    modelSubstitutionsTotal.inc({ reason, surface });
  } catch {
    /* instrument-only — never let a metrics error touch the generation path */
  }
}
