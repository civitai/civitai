import { isEqual } from 'lodash-es';
import { logToAxiom } from '~/server/logging/client';
import { formGraphShadowParseCounter } from '~/server/prom/form-graph.metrics';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { reconcileSelectors } from '~/shared/form-graph/generation/reconcile';

/**
 * The form-graph cutover's server side, gated by the ONE cutover flag —
 * the `formGraphGenerator` feature flag, read per-user from the generation
 * context. Every parse runs BOTH engines and records the comparison
 * (`form_graph_shadow_parse_total`, divergences logged with diff KEYS only —
 * no field values, so no prompts or user content reach the log); the hub
 * result is SERVED for users whose flag is on. The v1 parse always runs
 * (it feeds the substitution metrics and the reverse comparison). Both the
 * flag and this whole module go away in the delete-data-graph change, which
 * ports the metrics tap onto the hub's correction notes.
 */

export type HubParse =
  | {
      ok: true;
      data: Record<string, unknown>;
      /** Wire-named computed keys, straight from the parse result. */
      computedKeys: readonly string[];
    }
  | { ok: false; errors: Record<string, { message: string }> };

/** The hub parse, never throwing — a throw is a divergence class of its own. */
export function runHubParse(
  input: Record<string, unknown>,
  externalCtx: GenerationCtx
): HubParse | { ok: null; error: unknown } {
  try {
    const result = generationHub.parse(reconcileSelectors(input).raw, externalCtx);
    return result.success
      ? {
          ok: true,
          data: result.data as Record<string, unknown>,
          computedKeys: result.computedKeys ?? [],
        }
      : { ok: false, errors: result.errors };
  } catch (error) {
    return { ok: null, error };
  }
}

/**
 * Compare the two parses and record the outcome. Only key-level information
 * leaves this function: which top-level keys differ, never their values.
 */
export function recordShadowComparison(
  v1: { success: boolean; data?: Record<string, unknown>; errors?: Record<string, unknown> },
  hub: ReturnType<typeof runHubParse>,
  workflow: string
) {
  // The workflow arrives pre-parse, so it is an arbitrary caller string: clamp
  // to the known set before it becomes a prom label (unbounded cardinality) or
  // an Axiom field (user content).
  const label = workflowConfigByKey.has(workflow) ? workflow : 'unknown';
  const emit = (outcome: 'match' | 'diverged' | 'error', detail?: Record<string, unknown>) => {
    formGraphShadowParseCounter.inc({ outcome, workflow: label });
    if (outcome !== 'match') {
      logToAxiom({
        name: 'form-graph-shadow-parse',
        type: outcome,
        workflow: label,
        ...detail,
      }).catch(() => undefined);
    }
  };

  if (hub.ok === null) {
    // Only the error's NAME: a thrown zod error's message embeds the received
    // value, which must not reach the log.
    emit('error', { errorName: hub.error instanceof Error ? hub.error.name : typeof hub.error });
    return;
  }

  if (v1.success !== hub.ok) {
    emit('diverged', {
      kind: 'success-disagreement',
      v1Success: v1.success,
      hubSuccess: hub.ok,
      errorKeys: Object.keys((v1.success ? (hub as { errors?: object }).errors : v1.errors) ?? {}),
    });
    return;
  }

  if (!v1.success && hub.ok === false) {
    const v1Keys = Object.keys(v1.errors ?? {}).sort();
    const hubKeys = Object.keys(hub.errors).sort();
    if (isEqual(v1Keys, hubKeys)) emit('match');
    else emit('diverged', { kind: 'error-keys', v1Keys, hubKeys });
    return;
  }

  const v1Data = v1.data ?? {};
  const hubData = hub.ok === true ? hub.data : {};
  const keys = new Set([...Object.keys(v1Data), ...Object.keys(hubData)]);
  const differing: string[] = [];
  for (const key of keys) {
    if (!isEqual(v1Data[key], hubData[key])) differing.push(key);
  }
  if (differing.length === 0) emit('match');
  else emit('diverged', { kind: 'data-keys', keys: differing.sort() });
}
