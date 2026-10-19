import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { actions as editorActions } from '../+page.server';
import { createCosmeticDefinitions, readCosmeticEvents, withShelfPrices } from '$lib/server/item-definitions.service';
import { readBoxForEditor } from '$lib/server/mystery-box-builder.service';
import { int4Id, jsonField, parseForm } from '$lib/server/query';

export const load: PageServerLoad = async ({ params }) => {
  const parsed = int4Id.safeParse(params.id);
  if (!parsed.success) error(404, 'No such box.');
  const [editor, events] = await Promise.all([readBoxForEditor(parsed.data), readCosmeticEvents()]);
  if (!editor) error(404, 'No such box.');
  return { ...editor, rewards: await withShelfPrices(editor.rewards), events };
};

const defineSchema = z.object({ cosmeticIds: jsonField(z.array(int4Id).min(1).max(200), 'Pick at least one cosmetic.') });

/**
 * The save, publish, listing, archive and version actions are the editor's own, so this screen cannot
 * drift from what the editor accepts. `define` is the one addition: a cosmetic needs an item definition
 * before a box can hold it, and creating one never touches a box.
 */
export const actions: Actions = {
  ...(editorActions as unknown as Actions),
  define: async ({ request, locals }) => {
    const input = parseForm(defineSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'define', error: input });
    const result = await createCosmeticDefinitions({
      selector: { cosmeticIds: input.cosmeticIds },
      userId: locals.user.id,
    });
    if (!result.created && !result.alreadyDefined)
      return fail(400, { scope: 'define', error: 'No cosmetic matched.' });
    return { scope: 'define', defined: result };
  },
};
