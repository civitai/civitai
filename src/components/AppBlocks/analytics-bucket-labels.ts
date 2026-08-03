import { READ_SCOPE_LABELS } from '~/shared/constants/block-action-detail';

/**
 * Human labels for the App analytics panel's two "top N" rollup cards.
 *
 * #3561 bounded `block_scope_invocations.endpoint` so the `topEndpoints` rollup could
 * aggregate at all. A side effect: the internal tokens (`workflow:submit`,
 * `storage:set`, …) went from a count-1 long tail to the TOP rows of that card, where
 * they rendered verbatim. `topScopes` next to it had the same problem all along.
 *
 * 🔴 WHY THESE ARE NOT `humaniseScopeInvocation` (AppActivityPanel).
 * That is the real near-duplicate — the Activity feed's Action-column labeller. It is
 * prefix-based, needs no `detail`, and already maps all four endpoint tokens, so it is
 * the function a reader will reach for. Two reasons it cannot serve these cards:
 *   1. REGISTER. It names a single past event ("Generated an image"), which is wrong
 *      against a count — "Generated an image … 245" does not read. These cards need
 *      plural nouns, so the strings differ BY DESIGN.
 *   2. PASS-THROUGH. Roughly half of `topEndpoints` is REST paths from
 *      `normalizeEndpoint(req.url)`, which that function has no arm for: it would fall
 *      to its scope→label map and, called with no meaningful scope, yield ''  — a blank
 *      row. It also cannot distinguish the legacy per-id buckets below.
 * (`humaniseScopeEndpoint`, the Detail-column labeller, is unsuitable for a further
 * reason — it resolves a per-ROW id out of `detail`, which an aggregate bucket has
 * none of. Both are pinned by tests calling the real functions.)
 *
 * 🔴 VOCABULARY. The nouns here are the PLURALISED forms of what the Activity tab
 * already says, so one event is not named two different things across two tabs of the
 * same page. If you change a label here, change it there too — `humaniseScopeInvocation`
 * and `describeBlockAction` are the other two places these operations are named.
 *
 * Lives in its own module (not inside AppAnalyticsPanel.tsx) so these pure assertions
 * run in the `unit` project; importing the panel would drag in Mantine + chart.js.
 */

/**
 * The bounded endpoint tokens the server writes, and their labels.
 *
 * A `Map`, deliberately not a `Record`: an object index is prototype-reachable, so
 * `labels['constructor']` returns a FUNCTION and a truthy check on it would hand React
 * a non-string child. Unreachable from any current writer (every non-literal value
 * comes from `normalizeEndpoint` and contains a `/`), but the `Record` signature was
 * lying about it.
 *
 * Kept in lockstep with the server by `analytics-bucket-labels.drift.test.ts`, which
 * greps the `recordScopeInvocation` call sites rather than trusting this comment.
 */
const ENDPOINT_LABELS = new Map<string, string>([
  ['workflow:submit', 'Generations'],
  ['storage:set', 'App-local storage writes'],
  ['storage:delete', 'App-local storage deletes'],
  ['user-settings:write', 'Block settings saves'],
]);

/** The bounded tokens that can carry a legacy per-id / per-key tail. */
const TAILED = /^(workflow:submit|storage:set|storage:delete):(.+)$/;

/**
 * `'pending'` is NOT a workflow id. Pre-#3561 the writer was
 * `` `workflow:submit:${snapshot.workflowId || 'pending'}` ``, so it is the historical
 * stand-in for "no id was captured" on an OTHERWISE COMPLETED submit. Rendering it as
 * `(pending)` would tell an author those submits are still in flight — the opposite of
 * what the row means. `humaniseScopeEndpoint` carves out the same sentinel for the same
 * reason; if you touch one, read the other.
 */
const NO_ID_SENTINEL = 'pending';

/** Human label for one `topEndpoints` bucket. */
export function endpointBucketLabel(endpoint: string): string {
  const exact = ENDPOINT_LABELS.get(endpoint);
  if (exact) return exact;

  // Legacy rows: #3561 bounded these tokens but ran NO data migration, so a range
  // covering older activity still yields per-id / per-key buckets. Label the operation
  // and keep the tail so two legacy buckets stay distinguishable — they are separate
  // rows with separate counts, and merging them here would misreport what the aggregate
  // returned.
  const tailed = endpoint.match(TAILED);
  if (tailed) {
    const base = ENDPOINT_LABELS.get(tailed[1]) as string;
    return tailed[2] === NO_ID_SENTINEL ? `${base} (no id)` : `${base} (${tailed[2]})`;
  }

  // Everything else is a REST path from `normalizeEndpoint(req.url)`. Passed through
  // verbatim, and NOT claimed to be safe or pretty: that function templates only
  // numeric and ULID-shaped segments, so a slug/UUID segment survives, the row is
  // written from `res.on('finish')` regardless of status code, and the value is
  // therefore partly caller-influenced. React escapes it (no injection) and the cell
  // clamps to one line. Inventing a name for it would be worse than showing it.
  return endpoint;
}

/**
 * Labels for the `topScopes` card. Reads come from the shared `READ_SCOPE_LABELS`
 * registry; the write/other scopes written at `recordScopeInvocation` call sites are
 * added here. Pluralised to match the endpoint card's register.
 */
const WRITE_SCOPE_LABELS = new Map<string, string>([
  ['ai:write:budgeted', 'AI workflow submits'],
  ['apps:storage', 'App-local storage calls'],
  ['user-settings:write', 'Block settings saves'],
  ['block:settings:write', 'Block settings saves'],
  ['social:tip:self', 'Tips'],
  // Not a scope — the middleware's literal placeholder for a route that requires only a
  // valid block token and no particular scope (`opts.requiredScope ?? '(any-token)'`).
  // It appears verbatim in the data, so it needs a row label.
  ['(any-token)', 'Any-token routes (no scope required)'],
]);

/** Human label for one `topScopes` bucket. */
export function scopeBucketLabel(scope: string): string {
  const write = WRITE_SCOPE_LABELS.get(scope);
  if (write) return write;
  // READ_SCOPE_LABELS is a plain Record shared with the Activity panel, so guard the
  // prototype the same way the Map above does implicitly.
  if (Object.hasOwn(READ_SCOPE_LABELS, scope)) {
    const label = READ_SCOPE_LABELS[scope];
    if (typeof label === 'string') return label;
  }
  // An unmapped scope is shown as-is rather than guessed at — same reasoning as the
  // REST-path pass-through above.
  return scope;
}
