import { registerCounterWithLabels } from '@civitai/telemetry/client';

/**
 * Shadow-parse comparison outcomes for the form-graph cutover: every
 * server-side generation parse runs through BOTH graphs and the results are
 * compared. `match` should be the only outcome; a sustained zero on the
 * others is the criterion for widening the `formGraphGenerator` flag.
 *
 * outcome: match | diverged (results differ) | error (the hub parse threw)
 */
export const formGraphShadowParseCounter = registerCounterWithLabels({
  name: 'form_graph_shadow_parse_total',
  help: 'Form-graph shadow parse comparisons by outcome (match/diverged/error) and workflow',
  labelNames: ['outcome', 'workflow'] as const,
});
