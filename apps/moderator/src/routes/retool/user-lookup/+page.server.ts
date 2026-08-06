import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseQuery } from '$lib/server/query';
import { addUserNote, updateUserNote } from '$lib/server/moderation-memory.service';
import {
  addTimedMute,
  forceLogout,
  revokeTimedMute,
  setBanned,
  setMuted,
} from '$lib/server/user-actions.service';
import { getUserLookup, resolveUserId } from '$lib/server/user-lookup.service';

const querySchema = z.object({ q: z.string().trim().catch('') });

export const load: PageServerLoad = async ({ url, locals }) => {
  const { q } = parseQuery(url, querySchema);
  // `canAct` gates the enforcement UI; the actions re-check it server-side regardless.
  const canAct = canAccess(locals.user, '/users');
  if (!q) return { q, canAct, result: null, notFound: false };

  const userId = await resolveUserId(q);
  if (!userId) return { q, canAct, result: null, notFound: true };

  return { q, canAct, result: await getUserLookup(userId), notFound: false };
};

const NOTE_MAX = 5000;

export const actions: Actions = {
  addNote: async ({ request, locals }) => {
    const author = locals.user.username;
    // Notes are attributed by name; without one there is nothing to record or to authorise edits by.
    if (!author)
      return fail(400, {
        scope: 'notes',
        error: 'Your account has no username to attribute the note to.',
      });

    const form = await request.formData();
    const userId = Number(form.get('userId'));
    const notes = String(form.get('notes') ?? '').trim();
    if (!userId) return fail(400, { scope: 'notes', error: 'Missing user.' });
    if (!notes) return fail(400, { scope: 'notes', error: 'Note is empty.' });
    if (notes.length > NOTE_MAX)
      return fail(400, { scope: 'notes', error: `Note is over ${NOTE_MAX} characters.` });

    await addUserNote({ userId, notes, author });
    return { success: true };
  },

  editNote: async ({ request, locals }) => {
    const author = locals.user.username;
    if (!author) return fail(400, { scope: 'notes', error: 'Your account has no username.' });

    const form = await request.formData();
    const id = Number(form.get('id'));
    const notes = String(form.get('notes') ?? '').trim();
    if (!id) return fail(400, { scope: 'notes', error: 'Missing note.' });
    if (!notes) return fail(400, { scope: 'notes', error: 'Note is empty.' });
    if (notes.length > NOTE_MAX)
      return fail(400, { scope: 'notes', error: `Note is over ${NOTE_MAX} characters.` });

    // Returns false when the note is not this moderator's — the update is scoped by author in SQL, so
    // a forged id changes nothing.
    const updated = await updateUserNote({ id, notes, author });
    if (!updated) return fail(403, { scope: 'notes', error: 'You can only edit your own notes.' });
    return { success: true };
  },

  // ENFORCEMENT. Every action below is gated on `/users` rather than this page: reaching User Lookup
  // is an investigation permission, acting on an account is a different one.
  setMuted: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users'))
      return fail(403, { scope: 'account', error: 'Not permitted.' });
    const form = await request.formData();
    const userId = Number(form.get('userId'));
    if (!userId) return fail(400, { scope: 'account', error: 'Missing user.' });
    const muted = form.get('muted') === 'true';

    const result = await setMuted({ userId, muted, moderatorId: locals.user.id });
    if (!result.ok) return fail(400, { scope: 'account', error: result.error });
    return { success: true };
  },

  forceLogout: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users'))
      return fail(403, { scope: 'account', error: 'Not permitted.' });
    const form = await request.formData();
    const userId = Number(form.get('userId'));
    if (!userId) return fail(400, { scope: 'account', error: 'Missing user.' });

    await forceLogout({ userId, moderatorId: locals.user.id });
    return { success: true };
  },

  setBanned: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users'))
      return fail(403, { scope: 'account', error: 'Not permitted.' });
    const form = await request.formData();
    const userId = Number(form.get('userId'));
    if (!userId) return fail(400, { scope: 'account', error: 'Missing user.' });
    const ban = form.get('ban') === 'true';
    const reasonCode = String(form.get('reasonCode') ?? '').trim() || undefined;
    const detailsInternal = String(form.get('detailsInternal') ?? '').trim() || undefined;

    const result = await setBanned({
      userId,
      ban,
      reasonCode,
      detailsInternal,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return fail(400, { scope: 'account', error: result.error });
    return { success: true };
  },

  addTimedMute: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users'))
      return fail(403, { scope: 'account', error: 'Not permitted.' });
    const author = locals.user.username;
    if (!author) return fail(400, { scope: 'account', error: 'Your account has no username.' });

    const form = await request.formData();
    const userId = Number(form.get('userId'));
    const hours = Number(form.get('hours'));
    const reason = String(form.get('reason') ?? '').trim();
    if (!userId) return fail(400, { scope: 'account', error: 'Missing user.' });
    if (!Number.isFinite(hours) || hours <= 0)
      return fail(400, { scope: 'account', error: 'Duration must be > 0.' });
    if (!reason) return fail(400, { scope: 'account', error: 'A reason is required.' });

    const until = new Date(Date.now() + hours * 3_600_000);
    await addTimedMute({ userId, until, reason, author, moderatorId: locals.user.id });
    return { success: true };
  },

  revokeTimedMute: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users'))
      return fail(403, { scope: 'account', error: 'Not permitted.' });
    const form = await request.formData();
    const id = Number(form.get('id'));
    const userId = Number(form.get('userId'));
    if (!id || !userId) return fail(400, { scope: 'account', error: 'Missing mute.' });

    const result = await revokeTimedMute({ id, userId, moderatorId: locals.user.id });
    if (!result.ok) return fail(400, { scope: 'account', error: result.error });
    return { success: true };
  },
};
