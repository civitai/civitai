import { isEqual } from 'lodash-es';
import { FLIPT_FEATURE_FLAGS, isFliptSync } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { formGraphShadowParseCounter } from '~/server/prom/form-graph.metrics';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { reconcileSelectors } from '~/shared/form-graph/generation/reconcile';

/**
 * The form-graph cutover's server side, staged behind two Flipt flags:
 *
 * 1. `form-graph-shadow-parse` — every generation parse ALSO runs through
 *    `generationHub`; results are compared and divergence is counted
 *    (`form_graph_shadow_parse_total`) and logged with diff KEYS only — no
 *    field values, so no prompts or user content reach the log.
 * 2. `form-graph-parse` — the hub result is SERVED. The v1 parse still runs
 *    (it feeds the substitution metrics and the reverse shadow-compare);
 *    dropping it entirely belongs to the delete-data-graph change, which
 *    ports the metrics tap onto the hub's correction notes.
 *
 * Both flags default off; with neither set this module costs one sync flag
 * check per parse.
 */

export type HubParse =
  | {
      ok: true;
      data: Record<string, unknown>;
      /** Wire-named computed keys, straight from the parse result. */
      computedKeys: readonly string[];
    }
  | { ok: false; errors: Record<string, { message: string }> };

export function shadowFlags() {
  const serve = isFliptSync(FLIPT_FEATURE_FLAGS.FORM_GRAPH_PARSE) === true;
  const shadow = serve || isFliptSync(FLIPT_FEATURE_FLAGS.FORM_GRAPH_SHADOW_PARSE) === true;
  return { serve, shadow };
}

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
