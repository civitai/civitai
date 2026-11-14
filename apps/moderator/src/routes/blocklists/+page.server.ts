import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { BLOCKLIST_TYPES } from '$lib/blocklist';
import { callModEndpoint } from '$lib/server/user-actions.service';
import { inertEntries, inertEntriesError, parseRowId } from './form';
import {
  BlocklistRowMismatchError,
  getBlocklistDTO,
  upsertBlocklist,
  removeBlocklistItems,
} from '$lib/server/blocklist.service';

const querySchema = z.object({
  type: z.enum(BLOCKLIST_TYPES).catch(BLOCKLIST_TYPES[0]),
});

export const load: PageServerLoad = async ({ url }) => {
  const { type } = parseQuery(url, querySchema);
  const blocklist = await getBlocklistDTO({ type });
  return { type, blocklist };
};

const parseItems = (raw: FormDataEntryValue | null) =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const isType = (t: string): t is (typeof BLOCKLIST_TYPES)[number] =>
  (BLOCKLIST_TYPES as readonly string[]).includes(t);

const dryRunVerdict = z.object({
  verdict: z.union([z.string(), z.literal(false)]),
  result: z.enum(['allow', 'narrow', 'refuse']),
});
const dryRunResponse = z.object({ nonModerator: dryRunVerdict, moderator: dryRunVerdict });
export type DryRunState = z.infer<typeof dryRunResponse> & { query: string };

export const actions: Actions = {
  // The main app's query audit, rules included; it answers the verdict only, never what matched.
  dryRun: async ({ request }) => {
    const form = await request.formData();
    const query = String(form.get('query') ?? '').trim();
    if (!query) return fail(400, { dryRunError: 'Enter a query to test.' });
    if (query.length > 500)
      return fail(400, { dryRunError: 'Keep the query under 500 characters.' });

    const result = await callModEndpoint('search-query-rule-dry-run', { query }, 'Dry run');
    if (!result.ok)
      return fail(result.status && result.status >= 400 ? result.status : 502, {
        dryRunError: result.error,
      });
    const parsed = dryRunResponse.safeParse(result.body);
    if (!parsed.success)
      return fail(502, { dryRunError: 'The dry run answered in an unexpected shape.' });
    const dryRun: DryRunState = { query, ...parsed.data };
    return { dryRun };
  },
  add: async ({ request, locals }) => {
    const form = await request.formData();
    const type = String(form.get('type') ?? '');
    const id = parseRowId(form.get('id'));
    const items = parseItems(form.get('blocklist'));

    if (!isType(type)) return fail(400, { error: 'Invalid blocklist type.' });
    if (id === null) return fail(400, { error: 'Invalid blocklist row.' });
    if (items.length === 0) return fail(400, { error: 'No items to add.' });

    const inert = inertEntries(type, items);
    if (inert.length > 0) return fail(400, { error: inertEntriesError(type, inert) });

    // `type` and `id` arrive as two independent form fields, so the pair is checked in the
    // statement itself rather than here — see `upsertBlocklist`.
    let result;
    try {
      result = await upsertBlocklist({ id, type, blocklist: items, userId: locals.user.id });
    } catch (error) {
      if (error instanceof BlocklistRowMismatchError)
        return fail(409, {
          error: 'That list has changed since this page loaded. Reload and try again.',
        });
      throw error;
    }

    // The count the row GAINED, not the count submitted. Re-adding entries already on the list is
    // a no-op, and reporting the submission as if it landed is the defect the removal count was
    // fixed for.
    if (result.count === 0)
      return fail(409, {
        error: 'Nothing was added — every one of those entries is already on this list.',
      });

    return { success: true, action: 'add', count: result.count, cacheStale: result.cacheStale };
  },
  remove: async ({ request, locals }) => {
    const form = await request.formData();
    const type = String(form.get('type') ?? '');
    const id = parseRowId(form.get('id'));
    const items = parseItems(form.get('blocklist'));

    if (!isType(type)) return fail(400, { error: 'Invalid blocklist type.' });
    if (!id) return fail(400, { error: 'Nothing to remove from.' });
    if (items.length === 0) return fail(400, { error: 'No items to remove.' });

    const result = await removeBlocklistItems({ id, type, items, userId: locals.user.id });
    // A submitted-but-unmatched removal is a failure, not a quiet "Removed 0 items." The list is
    // served from a short-lived Redis cache, so the likeliest cause is that this page is stale. An
    // id belonging to another type lands here too.
    if (result.count === 0)
      return fail(409, {
        error: 'Nothing was removed — those entries are no longer on this list. Reload the page.',
      });

    return { success: true, action: 'remove', count: result.count, cacheStale: result.cacheStale };
  },
};
