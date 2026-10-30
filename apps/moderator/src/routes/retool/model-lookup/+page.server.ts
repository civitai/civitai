import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { lookupQuerySchema, parseForm, parseQuery } from '$lib/server/query';
import { MAX_INT4 } from '$lib/server/users.service';
import { getModelLookup, resolveModelRefLive } from '$lib/server/model-lookup.service';
import { addModelNote, updateModelNote } from '$lib/server/model-notes.service';
import { NOTE_MAX } from './model-notes';

// Model ACTIONS live on the main-app model page and Bulk Image Manager, and a copy here would be a
// second write path per action. `ModelNotes` is the exception — nothing else writes it.
export const load: PageServerLoad = async ({ url }) => {
  const { q } = parseQuery(url, lookupQuerySchema);

  // `?mv=` is the UNAMBIGUOUS version entry point, and it exists because `q` cannot be: a bare number is
  // a valid model id AND a valid version id across most of the range, so a link that means "this
  // version" has to say so out of band. Expressed as the term shape the resolver already recognises
  // rather than as a second resolution path that could disagree with it.
  const mv = url.searchParams.get('mv')?.trim() ?? '';
  const term = /^\d+$/.test(mv) ? `/model-versions/${mv}` : q;

  if (!term)
    return {
      q,
      mv,
      result: null,
      highlightVersionId: null,
      resolvedFromVersion: null,
      alsoAVersion: null,
      notFound: false,
    };

  const ref = await resolveModelRefLive(term);
  const result = ref ? await getModelLookup(ref.modelId) : null;

  return {
    // NOT the `?mv=` id. `LookupSearch` replaces the whole query string on submit, so echoing it here
    // would turn `?mv=5` into `?q=5` — which resolves model-first and can land on a different row.
    q: mv ? '' : q,
    mv,
    result,
    highlightVersionId: ref?.versionId ?? null,
    resolvedFromVersion: ref?.resolvedFromVersion ?? null,
    alsoAVersion: ref?.alsoAVersion ?? null,
    notFound: !result,
  };
};

const noteSchema = z.object({ content: z.string().trim().min(1).max(NOTE_MAX) });
const noteFail = (status: number, message: string) => fail(status, { error: message });

// An uncaught rejection renders the error boundary, which unmounts the page and takes the note the
// operator just typed with it.
const caught = async (run: () => Promise<ReturnType<typeof noteFail> | { success: true }>) => {
  try {
    return await run();
  } catch (e) {
    console.error('[model-notes] write failed', e);
    return noteFail(500, 'Could not reach the moderator database. Your note was not saved.');
  }
};

export const actions: Actions = {
  addNote: async ({ request, locals }) => {
    const author = locals.user.username;
    // Notes are attributed by name; without one there is nothing to record or to authorise edits by.
    if (!author) return noteFail(400, 'Your account has no username to attribute the note to.');

    const input = parseForm(
      noteSchema.extend({ modelId: z.coerce.number().int().positive().max(MAX_INT4) }),
      await request.formData()
    );
    if (typeof input === 'string') return noteFail(400, input);

    return caught(async () => {
      await addModelNote({
        modelId: input.modelId,
        content: input.content,
        author,
        moderatorId: locals.user.id,
      });
      return { success: true };
    });
  },

  editNote: async ({ request, locals }) => {
    const author = locals.user.username;
    if (!author) return noteFail(400, 'Your account has no username.');

    const input = parseForm(
      noteSchema.extend({ id: z.coerce.number().int().positive() }),
      await request.formData()
    );
    if (typeof input === 'string') return noteFail(400, input);

    return caught(async () => {
      const updated = await updateModelNote({
        id: input.id,
        content: input.content,
        author,
        moderatorId: locals.user.id,
      });
      return updated ? { success: true } : noteFail(403, 'You can only edit your own notes.');
    });
  },
};
