import * as z from 'zod';
import { MODELS_SEARCH_INDEX } from '~/server/common/constants';
import { searchClient } from '~/server/meilisearch/client';
import { modelsDisplayedAttributes } from '~/server/search-index/displayed-attributes';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { booleanString } from '~/utils/zod-helpers';

/**
 * Apply `modelsDisplayedAttributes` to the LIVE models index.
 *
 * Hidden admin route. Guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Why this exists: nothing else can apply `modelsDisplayedAttributes` to a live index. The cause
 * is the same one the sibling filterable route exists for — `onIndexSetup` is the only in-repo
 * writer of these settings and it runs in exactly one place, `reset()` in base.search-index.ts,
 * against the `_NEW` swap index, and `search-index-sync-models-reset` is `UNRUNNABLE_JOB_CRON`.
 * So an edit to the list is inert on a live index until either a reset rebuilds every document or
 * this runs.
 *
 * 🔴 That matters more here than for the filterable list, because this one is a PRIVACY BOUNDARY:
 * see `src/server/search-index/displayed-attributes.ts` for what it withholds and why. Operational
 * state — which index is currently narrowed, and what that has meant — is deliberately NOT recorded
 * in this repo.
 *
 * Unlike `filterableAttributes`, this setting is a projection applied when a hit is serialised,
 * so it should be far cheaper than a facet reindex. That is NOT measured on a populated index —
 * poll the returned `taskUid` rather than assuming it is instant. A settings task can also sit
 * behind whatever else is queued, so "enqueued" and "applied" can be a long way apart.
 *
 * THREE refusals, because `updateDisplayedAttributes` REPLACES the list rather than merging:
 *
 * - A write that REDUCES what the index returns needs `allowRemove=true`. That covers both shapes:
 *   a named attribute live on the index but missing from the code list, and the `["*"]` default,
 *   where narrowing is the whole point but still changes every search response. Reducing display
 *   scope is not symmetric with widening it — a client reading a field that stops being returned
 *   breaks silently, with `undefined` rather than an error.
 * - A pending settings task refuses unless `force=true`. `getDisplayedAttributes` reports what is
 *   APPLIED, so between enqueue and applied a second call sees the same diff and would enqueue a
 *   second write. There is no method guard on `WebhookEndpoint`, so a browser reload is enough.
 * - Not being able to TELL whether a task is pending is itself a refusal, same as the sibling
 *   route: turning a permissions problem into a green light is how you get the double write.
 *
 * `willStopReturning` is DISCLOSURE, not a gate. It reads the live field distribution and names
 * the attributes documents actually carry that this write would stop returning, so the operator
 * sees the real consequence instead of inferring it from a 35-entry list. It is `null` when the
 * stats call could not be reached — the gate above stays deterministic either way, because it
 * keys on intent (`allowRemove`) rather than on a reading that might be missing.
 *
 * Usage:
 *   # read-only, reports exactly what would change:
 *   POST /api/admin/temp/apply-models-index-displayed-attributes?token=$WEBHOOK_TOKEN
 *
 *   # the write, once you have read `willStopReturning` and accept the losses:
 *   POST /api/admin/temp/apply-models-index-displayed-attributes?token=$WEBHOOK_TOKEN
 *     &dryRun=false&allowRemove=true
 *
 *   # RESET TO MEILI'S DEFAULT — this route has no restore branch, and there is no in-repo caller.
 *   #   curl -X DELETE -H "Authorization: Bearer $SEARCH_API_KEY" \
 *   #     "$SEARCH_HOST/indexes/models_v9/settings/displayed-attributes"
 *   # The index name is LITERAL on purpose: `MODELS_SEARCH_INDEX` is a TypeScript constant, not an
 *   # env var, so pasting `$MODELS_SEARCH_INDEX` into a shell yields `/indexes//settings/...` and a
 *   # 404 that reads as "the route does not exist".
 *   #
 *   # 🔴 This is only an UNDO from the `["*"]` default. It resets to `["*"]`, so run from an
 *   # explicit list it WIDENS past that list and puts every withheld attribute — `sortMetrics`
 *   # included — back into every hit. That is the leak this route exists to close, re-opened by
 *   # following this instruction in the wrong state. To go back to a PREVIOUS list, PUT that list.
 *   # Written out at all because a client reading a field that stopped being returned breaks
 *   # SILENTLY, so the undo is wanted exactly when the cause is least obvious.
 *
 * Params (query):
 *   dryRun      - default true. Report the current list and what would change, write nothing.
 *   allowRemove - default false. Permit a write that reduces what the index returns.
 *   force       - default false. Permit a write while a settings task is already enqueued.
 */

const schema = z.object({
  dryRun: booleanString().default(true),
  allowRemove: booleanString().default(false),
  force: booleanString().default(false),
});

/**
 * Returns null when the tasks API could not be reached or refused. That is deliberately distinct
 * from an empty array: [] means "checked, nothing pending", null means "do not know", and the
 * write path treats not-knowing as a refusal.
 *
 * The SDK scopes this to the index handle (it sends indexUids=<uid>), so it does not scan globally.
 */
async function pendingSettingsTaskUids(index: {
  getTasks: (q: { statuses: string[]; types: string[] }) => Promise<{ results: { uid: number }[] }>;
}) {
  try {
    const tasks = await index.getTasks({
      statuses: ['enqueued', 'processing'],
      types: ['settingsUpdate'],
    });
    return tasks.results.map((t) => t.uid);
  } catch {
    return null;
  }
}

/**
 * Top-level attributes that documents CARRY but the desired list does not display — i.e. what this
 * write would actually stop returning. Null when the stats call failed, which is distinct from an
 * empty array meaning "checked, nothing is lost".
 */
async function willStopReturning(
  index: { getStats: () => Promise<{ fieldDistribution?: Record<string, number> }> },
  desired: string[]
) {
  try {
    const stats = await index.getStats();
    // Compare on the FIRST dot-segment. Meilisearch flattens nested objects to dot notation
    // internally, so a distribution reporting `user.username` / `versions.id` would match nothing
    // in a list of top-level names and every nested field would read as a loss — burying the real
    // ones. Nested children ride along with their listed parent, so the parent is the right unit
    // whichever form the keys take. (Deliberately no measurement of any live index here.)
    const present = [
      ...new Set(Object.keys(stats?.fieldDistribution ?? {}).map((a) => a.split('.')[0])),
    ];
    return present.filter((a) => !desired.includes(a)).sort();
  } catch {
    return null;
  }
}

export default WebhookEndpoint(async (req, res) => {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { dryRun, allowRemove, force } = parsed.data;

  if (!searchClient) return res.status(503).json({ error: 'search client not configured' });

  // `index()` is a local handle — unlike getOrCreateIndex it cannot create an index as a side
  // effect of a typo in the name.
  const index = searchClient.index(MODELS_SEARCH_INDEX);
  const current = (await index.getDisplayedAttributes()) ?? [];
  const desired = [...modelsDisplayedAttributes];

  // `*` is Meili's display-everything default, not a named attribute, so it is never "extra" to be
  // removed by name — it is counted by `narrowing` instead. Conflating the two would report a
  // removal of an attribute that does not exist.
  const wildcard = current.includes('*');
  // 🔴 Under `*` the index ALREADY returns every one of these, so none of them is MISSING from what
  // clients receive. Computing `missing` by literal membership in `['*']` makes the whole desired
  // list "missing", and the response then reports a large `added` with an empty `removed` for a
  // write that adds nothing and removes whatever `willStopReturning` names — the exact inverse, in
  // the one transition this route exists for. No count is given here on purpose: the real number is
  // whatever the live field distribution minus this list comes to, nothing pins a literal, and the
  // figure this comment used to carry went stale inside its own commit.
  const missing = wildcard ? [] : desired.filter((a) => !current.includes(a));
  const extra = current.filter((a) => a !== '*' && !desired.includes(a as never));
  const pending = await pendingSettingsTaskUids(index as never);
  const stopReturning = await willStopReturning(index as never, desired);

  // Narrowing away from `*`, or dropping a named attribute, both reduce what clients receive.
  const reduces = wildcard || extra.length > 0;

  if (dryRun) {
    // Reports `pending`/`willStopReturning` as null rather than failing when those reads are
    // unavailable, so the read-only path still answers the question it is for — what would change.
    return res.status(200).json({
      dryRun: true,
      current,
      desired,
      missing,
      extra,
      narrowing: wildcard,
      willStopReturning: stopReturning,
      pending,
    });
  }

  if (!missing.length && !extra.length && !wildcard) {
    return res.status(200).json({ dryRun: false, unchanged: true, current });
  }

  if (reduces && !allowRemove) {
    return res.status(409).json({
      error: 'refusing a write that reduces what the index returns',
      narrowing: wildcard,
      extra,
      willStopReturning: stopReturning,
      hint: wildcard
        ? 'this index is on Meili\'s ["*"] default, so the write narrows it; pass allowRemove=true once you have read willStopReturning'
        : 'pass allowRemove=true only if you intend the live index to stop returning these',
    });
  }

  if (pending === null && !force) {
    return res.status(409).json({
      error: 'could not determine whether a settings task is already pending',
      hint: 'the tasks API was unreachable or refused; SEARCH_API_KEY may lack tasks.get. Pass force=true only if you have checked by hand',
    });
  }

  if (pending?.length && !force) {
    return res.status(409).json({
      error: 'a settings task is already enqueued on this index',
      pending,
      hint: 'wait for it to apply, then re-read; pass force=true only to enqueue a second write',
    });
  }

  const task = await index.updateDisplayedAttributes(desired);

  return res.status(200).json({
    dryRun: false,
    unchanged: false,
    added: missing,
    // Under `*` the losses are whatever the field distribution says, NOT `extra` — which excludes
    // `*` by design and is therefore always empty here. `null` when the stats read failed, so the
    // caller sees "not determined" rather than a confident empty list.
    removed: wildcard ? stopReturning : extra,
    narrowing: wildcard,
    willStopReturning: stopReturning,
    // Poll this. The call returns as soon as the task is ENQUEUED, which on a busy instance is a
    // long way from applied — until it does, the index keeps serving whatever its current list
    // allows, which is the state `willStopReturning` describes.
    taskUid: task.taskUid,
  });
});
