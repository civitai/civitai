import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { BLOCKLIST_TYPES } from '$lib/blocklist';
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

export const actions: Actions = {
  add: async ({ request }) => {
    const form = await request.formData();
    const type = String(form.get('type') ?? '');
    const idRaw = form.get('id');
    const id = idRaw ? Number(idRaw) : undefined;
    const items = parseItems(form.get('blocklist'));

    if (!isType(type)) return fail(400, { error: 'Invalid blocklist type.' });
    if (items.length === 0) return fail(400, { error: 'No items to add.' });

    // `type` and `id` arrive as two independent form fields, so the pair is checked in the
    // statement itself rather than here — see `upsertBlocklist`.
    let result;
    try {
      result = await upsertBlocklist({ id, type, blocklist: items });
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
  remove: async ({ request }) => {
    const form = await request.formData();
    const type = String(form.get('type') ?? '');
    const id = Number(form.get('id'));
    const items = parseItems(form.get('blocklist'));

    if (!isType(type)) return fail(400, { error: 'Invalid blocklist type.' });
    if (!id) return fail(400, { error: 'Nothing to remove from.' });
    if (items.length === 0) return fail(400, { error: 'No items to remove.' });

    const result = await removeBlocklistItems({ id, type, items });
    // A submitted-but-unmatched removal is a failure, not a quiet "Removed 0 items." The list is
    // served from a month-long Redis cache, so the likeliest cause is that this page is stale. An
    // id belonging to another type lands here too.
    if (result.count === 0)
      return fail(409, {
        error: 'Nothing was removed — those entries are no longer on this list. Reload the page.',
      });

    return { success: true, action: 'remove', count: result.count, cacheStale: result.cacheStale };
  },
};
