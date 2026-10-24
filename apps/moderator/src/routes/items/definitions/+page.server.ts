import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import {
  createCosmeticDefinitions,
  listCosmeticDefinitions,
  previewCosmeticDefinitions,
  type CosmeticSelector,
} from '$lib/server/item-definitions.service';
import { readCosmeticEvents } from '$lib/server/item-definitions.service';
import { parseIdPaste, parseQuery } from '$lib/server/query';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  event: z.string().trim().catch(''),
});

export const load: PageServerLoad = async ({ url }) => {
  const { page, event } = parseQuery(url, querySchema);
  const [list, events] = await Promise.all([
    listCosmeticDefinitions({ event, page }),
    readCosmeticEvents(),
  ]);
  return { page, event, events: events.map((e) => e.event), ...list };
};

const MAX_IDS = 1000;

/** From the form: an event, or pasted cosmetic ids (comma, space or newline separated). */
function selectorFrom(form: FormData): CosmeticSelector | string {
  const event = String(form.get('event') ?? '').trim();
  if (event) return { event };
  const cosmeticIds = parseIdPaste(String(form.get('cosmeticIds') ?? ''), MAX_IDS);
  return typeof cosmeticIds === 'string' ? cosmeticIds : { cosmeticIds };
}

export const actions: Actions = {
  preview: async ({ request }) => {
    const selector = selectorFrom(await request.formData());
    if (typeof selector === 'string') return fail(400, { error: selector });
    return { preview: await previewCosmeticDefinitions(selector) };
  },
  create: async ({ request, locals }) => {
    const selector = selectorFrom(await request.formData());
    if (typeof selector === 'string') return fail(400, { error: selector });
    const result = await createCosmeticDefinitions({ selector, userId: locals.user.id });
    if (!result.created && !result.alreadyDefined)
      return fail(400, { error: 'No cosmetics matched.' });
    return { created: result };
  },
};
