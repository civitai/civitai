import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { actions as editorActions } from '../+page.server';
import { canAccess } from '$lib/server/access';
import {
  createCosmeticDefinitions,
  readCosmeticEvents,
  withShelfPrices,
} from '$lib/server/item-definitions.service';
import { readBoxForEditor } from '$lib/server/mystery-box-builder.service';
import { int4Id, jsonField, parseForm } from '$lib/server/query';

/** Creating item definitions is the Item Definitions page's grant, which the box pages do not carry. */
const DEFINITIONS_PATH = '/items/definitions';

export const load: PageServerLoad = async ({ params, locals }) => {
  const parsed = int4Id.safeParse(params.id);
  if (!parsed.success) error(404, 'No such box.');
  const [editor, events] = await Promise.all([readBoxForEditor(parsed.data), readCosmeticEvents()]);
  if (!editor) error(404, 'No such box.');
  return {
    ...editor,
    rewards: await withShelfPrices(editor.rewards),
    events,
    canDefine: canAccess(locals.user, DEFINITIONS_PATH),
  };
};

const MAX_DEFINE = 200;
const defineSchema = z.object({
  cosmeticIds: jsonField(
    z.array(int4Id).min(1).max(MAX_DEFINE),
    `Pick between 1 and ${MAX_DEFINE} cosmetics.`
  ),
});

/** The editor's own actions are reused so both screens accept the same input; `define` is the only addition. */
export const actions: Actions = {
  ...(editorActions as unknown as Actions),
  define: async ({ request, locals }) => {
    if (!canAccess(locals.user, DEFINITIONS_PATH))
      return fail(403, {
        scope: 'define',
        error: 'Creating item definitions needs access to the Item Definitions page.',
      });
    const input = parseForm(defineSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'define', error: input });
    try {
      const result = await createCosmeticDefinitions({
        selector: { cosmeticIds: input.cosmeticIds },
        userId: locals.user.id,
      });
      if (!result.created && !result.alreadyDefined)
        return fail(400, { scope: 'define', error: 'No cosmetic matched.' });
      return { scope: 'define', defined: result };
    } catch (e) {
      console.error('[mystery-box-builder] define failed', e);
      return fail(500, {
        scope: 'define',
        error: 'Creating the definitions failed. Nothing was changed; try again.',
      });
    }
  },
};
