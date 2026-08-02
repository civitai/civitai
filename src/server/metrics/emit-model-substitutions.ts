import type { ModelSubstitutionCollector } from '~/shared/data-graph/generation/model-substitution';

/**
 * Drain a request's silent-checkpoint-substitution collector into
 * `civitai_generation_model_substitutions_total` (issue #3520, phase 1).
 *
 * WHY ITS OWN MODULE. The caller (`validateInput` in orchestration-new.service)
 * is SYNCHRONOUS and sits on the generation submit path, and the prom-client
 * module must stay out of its static import graph — the same reason
 * `app-spend-cap.service` reaches its emitters through `await import(...)`. This
 * module is the seam that lets both hold: it owns the dynamic import, and it is
 * small enough to unit-test the guarantee that matters (it can never reject into
 * the request).
 *
 * 🔴 NEVER REJECTS. The returned promise resolves on every path — a failed
 * dynamic import, a module whose shape changed, a prom-client registry
 * collision, a label mismatch. Callers `void` it; an unhandled rejection there
 * would be an unhandled rejection on the generation path, i.e. observability
 * converting a working generation into an incident. It also does no work at all
 * when nothing was substituted, which is the overwhelmingly common case.
 *
 * IDEMPOTENT via `takeUnemitted()`, which marks what it hands out — a second
 * call for the same request emits nothing rather than double-counting.
 */
export async function emitModelSubstitutions(
  collector: ModelSubstitutionCollector | undefined
): Promise<void> {
  try {
    if (!collector) return;
    const pending = collector.takeUnemitted();
    if (!pending.length) return;
    // The SURFACE comes off the collector, which got it from whoever built this
    // request's context (`buildGenerationContext(..., surface)`) — never guessed
    // here. `validateInput` is shared by the on-site generator, the App Blocks
    // bridge and preset generation, so this function structurally cannot tell
    // them apart and must not try.
    const { surface } = collector;
    const { recordGenerationModelSubstitution } = await import(
      '~/server/metrics/generation-model-substitution.metrics'
    );
    for (const substitution of pending)
      recordGenerationModelSubstitution(substitution.reason, surface);
  } catch {
    /* observability must never break the generation it observes */
  }
}
