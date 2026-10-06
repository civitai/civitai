import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { checkboxField, parseForm, parseQuery } from '$lib/server/query';
import {
  TestSetError,
  archiveSet,
  createSet,
  listSets,
} from '$lib/server/text-scan-lab/test-sets.service';

const querySchema = z.object({ archived: checkboxField.catch(false) });

export const load: PageServerLoad = async ({ url }) => {
  const { archived } = parseQuery(url, querySchema);
  return { sets: await listSets({ includeArchived: archived }), archived };
};

const refused = (e: unknown) => {
  if (e instanceof TestSetError) return fail(e.status, { error: e.message });
  throw e;
};

export const actions: Actions = {
  createSet: requiresGrant('textScan.testSet.edit', async ({ request, locals }) => {
    const input = parseForm(
      z.object({
        name: z.string().trim().min(1, 'Name the set.').max(100, 'Name is at most 100 characters.'),
        description: z
          .string()
          .trim()
          .max(2000, 'Description is at most 2000 characters.')
          .transform((v) => v || null)
          .optional()
          .default(null),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      const set = await createSet(input, locals.user.id);
      return { success: true, setId: set.id };
    } catch (e) {
      return refused(e);
    }
  }),

  archiveSet: requiresGrant('textScan.testSet.edit', async ({ request }) => {
    const input = parseForm(
      z.object({ setId: z.coerce.number().int().positive() }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      await archiveSet(input.setId);
      return { success: true };
    } catch (e) {
      return refused(e);
    }
  }),
};
