import { registerCounterWithLabels } from '@civitai/telemetry/client';

/**
 * Shadow-parse comparison outcomes for the form-graph cutover: while the
 * `form-graph-shadow-parse` flag is on, every server-side generation parse
 * runs through BOTH graphs and the results are compared. `match` should be
 * the only outcome; a sustained zero on the others is the flip criterion for
 * `form-graph-parse`.
 *
 * outcome: match | diverged (results differ) | error (the hub parse threw)
 */
export const formGraphShadowParseCounter = registerCounterWithLabels({
  name: 'form_graph_shadow_parse_total',
  help: 'Form-graph shadow parse comparisons by outcome (match/diverged/error) and workflow',
  labelNames: ['outcome', 'workflow'] as const,
});
