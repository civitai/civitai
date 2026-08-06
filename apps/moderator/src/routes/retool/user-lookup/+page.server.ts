import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseQuery } from '$lib/server/query';
import { addUserNote, updateUserNote } from '$lib/server/moderation-memory.service';
import {
  BAN_REASON_CODES,
  addTimedMute,
  forceLogout,
  revokeTimedMute,
  setBanned,
  setMuted,
  unmuteAndClearTimed,
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

// Every action's input is a zod parse, per the app standard. `fail` shapes carry the panel scope so each
// panel renders only its own error — see format.ts.
const accountFail = (message: string) => fail(400, { scope: 'account' as const, error: message });
const noteFail = (status: number, message: string) =>
  fail(status, { scope: 'notes' as const, error: message });

const userIdSchema = z.object({ userId: z.coerce.number().int().positive() });
const noteSchema = z.object({ notes: z.string().trim().min(1).max(NOTE_MAX) });

/** zod over FormData, with the first message rather than the full issue tree. */
function parseForm<T extends z.ZodType>(schema: T, form: FormData): z.infer<T> | string {
  const parsed = schema.safeParse(Object.fromEntries(form));
  return parsed.success ? parsed.data : (parsed.error.issues[0]?.message ?? 'Invalid input.');
}

export const actions: Actions = {
  addNote: async ({ request, locals }) => {
    const author = locals.user.username;
    // Notes are attributed by name; without one there is nothing to record or to authorise edits by.
    if (!author) return noteFail(400, 'Your account has no username to attribute the note to.');

    const input = parseForm(userIdSchema.merge(noteSchema), await request.formData());
    if (typeof input === 'string') return noteFail(400, input);

    await addUserNote({ userId: input.userId, notes: input.notes, author });
    return { success: true };
  },

  editNote: async ({ request, locals }) => {
    const author = locals.user.username;
    if (!author) return noteFail(400, 'Your account has no username.');

    const input = parseForm(
      z.object({ id: z.coerce.number().int().positive() }).merge(noteSchema),
      await request.formData()
    );
    if (typeof input === 'string') return noteFail(400, input);

    // Returns false when the note is not this moderator's — the update is scoped by author in SQL, so
    // a forged id changes nothing.
    const updated = await updateUserNote({ id: input.id, notes: input.notes, author });
    if (!updated) return noteFail(403, 'You can only edit your own notes.');
    return { success: true };
  },

  // ENFORCEMENT. Every action below is gated on `/users` rather than this page: reaching User Lookup
  // is an investigation permission, acting on an account is a different one.
  setMuted: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({ muted: z.enum(['true', 'false']) }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    // Unmuting closes out any timed mute too. Without it the account is unmuted while the moderator
    // database still holds an active schedule, and the panel shows a Mute button beside a live timed
    // mute — two contradictory statements about the same account.
    const result =
      input.muted === 'true'
        ? await setMuted({ userId: input.userId, muted: true, moderatorId: locals.user.id })
        : await unmuteAndClearTimed({ userId: input.userId, moderatorId: locals.user.id });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  forceLogout: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(userIdSchema, await request.formData());
    if (typeof input === 'string') return accountFail(input);

    const result = await forceLogout({ userId: input.userId, moderatorId: locals.user.id });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  setBanned: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    // reasonCode is validated against the SAME list the main app's endpoint parses. It rejects anything
    // else with a 500 before the ban happens, so an unchecked value here is a ban that silently does not
    // occur.
    const input = parseForm(
      userIdSchema.extend({
        ban: z.enum(['true', 'false']),
        reasonCode: z.enum(BAN_REASON_CODES).optional().or(z.literal('').transform(() => undefined)),
        detailsInternal: z.string().trim().max(2000).optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const result = await setBanned({
      userId: input.userId,
      ban: input.ban === 'true',
      reasonCode: input.reasonCode,
      detailsInternal: input.detailsInternal || undefined,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  addTimedMute: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const author = locals.user.username;
    if (!author) return accountFail('Your account has no username.');

    const input = parseForm(
      userIdSchema.extend({
        hours: z.coerce.number().positive().max(8760),
        reason: z.string().trim().min(1).max(500),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const until = new Date(Date.now() + input.hours * 3_600_000);
    const result = await addTimedMute({
      userId: input.userId,
      until,
      reason: input.reason,
      author,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  revokeTimedMute: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({ id: z.coerce.number().int().positive() }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const result = await revokeTimedMute({
      id: input.id,
      userId: input.userId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },
};
