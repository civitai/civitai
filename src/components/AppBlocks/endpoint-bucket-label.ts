/**
 * Human label for one `topEndpoints` BUCKET (the App analytics panel's
 * "Top endpoints" table).
 *
 * `endpoint` is the GROUP BY key of the topEndpoints rollup, so once #3561 bounded
 * it the internal tokens (`workflow:submit`, `storage:set`, …) became the top-ranked
 * rows of that table — the raw tokens went from long-tail to the most prominent
 * thing on the panel. This names the OPERATION, which is what a count is a count of.
 *
 * 🔴 Do NOT "simplify" this by reusing `humaniseScopeEndpoint` from
 * `~/components/Apps/AppActivityPanel`, even though it is exported and looks like
 * exactly the right function. That one labels a single ROW by resolving its
 * per-operation id out of `detail`, and an aggregate bucket has no `detail`:
 *   humaniseScopeEndpoint('workflow:submit')     -> '(no workflow id)'
 *   humaniseScopeEndpoint('user-settings:write') -> ''  (renders a BLANK cell)
 * Both are worse than printing the raw token, so these are genuinely two different
 * functions. `endpoint-bucket-label.test.ts` pins those two humaniser outputs so this
 * note cannot rot into "why didn't they just reuse it".
 *
 * Lives in its own module (not inside AppAnalyticsPanel.tsx) so it is testable in the
 * `unit` project — importing the panel would drag in Mantine + chart.js and force
 * these pure assertions into the browser tier.
 */

const ENDPOINT_BUCKET_LABELS: Record<string, string> = {
  'workflow:submit': 'Generation submits',
  'storage:set': 'App storage writes',
  'storage:delete': 'App storage deletes',
  'user-settings:write': 'User settings writes',
};

/** The bounded tokens that can carry a legacy per-id / per-key tail. */
const TAILED = /^(workflow:submit|storage:set|storage:delete):(.+)$/;

export function endpointBucketLabel(endpoint: string): string {
  const exact = ENDPOINT_BUCKET_LABELS[endpoint];
  if (exact) return exact;
  // Legacy rows: #3561 bounded these tokens but ran NO data migration, so a range
  // covering older activity still yields per-id / per-key buckets
  // (`workflow:submit:<id>`, `storage:set:<key>`). Label the operation and keep the
  // tail visible so two legacy buckets stay distinguishable — they are separate rows
  // with separate counts, and merging them here would misreport what the aggregate
  // actually returned.
  const tailed = endpoint.match(TAILED);
  if (tailed) return `${ENDPOINT_BUCKET_LABELS[tailed[1]]} (${tailed[2]})`;
  // Anything else is a REST path from `normalizeEndpoint(req.url)` — already
  // readable, and not ours to invent a name for.
  return endpoint;
}
