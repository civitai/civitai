import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { BLOCKLIST_TYPES } from '$lib/blocklist';
import {
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

    await upsertBlocklist({ id, type, blocklist: items });
    return { success: true, action: 'add', count: items.length };
  },
  remove: async ({ request }) => {
    const form = await request.formData();
    const id = Number(form.get('id'));
    const items = parseItems(form.get('blocklist'));

    if (!id) return fail(400, { error: 'Nothing to remove from.' });
    if (items.length === 0) return fail(400, { error: 'No items to remove.' });

    await removeBlocklistItems({ id, items });
    return { success: true, action: 'remove', count: items.length };
  },
};
