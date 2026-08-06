import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import { addUserNote, updateUserNote } from '$lib/server/moderation-memory.service';
import { getUserLookup, resolveUserId } from '$lib/server/user-lookup.service';

const querySchema = z.object({ q: z.string().trim().catch('') });

export const load: PageServerLoad = async ({ url }) => {
  const { q } = parseQuery(url, querySchema);
  if (!q) return { q, result: null, notFound: false };

  const userId = await resolveUserId(q);
  if (!userId) return { q, result: null, notFound: true };

  return { q, result: await getUserLookup(userId), notFound: false };
};

const NOTE_MAX = 5000;

export const actions: Actions = {
  addNote: async ({ request, locals }) => {
    const author = locals.user.username;
    // Notes are attributed by name; without one there is nothing to record or to authorise edits by.
    if (!author)
      return fail(400, { error: 'Your account has no username to attribute the note to.' });

    const form = await request.formData();
    const userId = Number(form.get('userId'));
    const notes = String(form.get('notes') ?? '').trim();
    if (!userId) return fail(400, { error: 'Missing user.' });
    if (!notes) return fail(400, { error: 'Note is empty.' });
    if (notes.length > NOTE_MAX)
      return fail(400, { error: `Note is over ${NOTE_MAX} characters.` });

    await addUserNote({ userId, notes, author });
    return { success: true };
  },

  editNote: async ({ request, locals }) => {
    const author = locals.user.username;
    if (!author) return fail(400, { error: 'Your account has no username.' });

    const form = await request.formData();
    const id = Number(form.get('id'));
    const notes = String(form.get('notes') ?? '').trim();
    if (!id) return fail(400, { error: 'Missing note.' });
    if (!notes) return fail(400, { error: 'Note is empty.' });
    if (notes.length > NOTE_MAX)
      return fail(400, { error: `Note is over ${NOTE_MAX} characters.` });

    // Returns false when the note is not this moderator's — the update is scoped by author in SQL, so
    // a forged id changes nothing.
    const updated = await updateUserNote({ id, notes, author });
    if (!updated) return fail(403, { error: 'You can only edit your own notes.' });
    return { success: true };
  },
};
