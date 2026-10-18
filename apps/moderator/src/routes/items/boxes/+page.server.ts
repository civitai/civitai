import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { createBox, listBoxes } from '$lib/server/mystery-box-builder.service';

export const load: PageServerLoad = async () => ({ boxes: await listBoxes() });

const createSchema = z.object({ name: z.string().trim().min(1).max(200) });

export const actions: Actions = {
  create: async ({ request, locals }) => {
    const parsed = createSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: 'Give the box a name.' });
    const id = await createBox({ name: parsed.data.name, userId: locals.user.id });
    redirect(303, `/items/boxes/${id}`);
  },
};
