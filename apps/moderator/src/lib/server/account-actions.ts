import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { canAccess, requiresGrant } from './access';
import { parseForm, userIdSchema } from './query';
import { banFieldsSchema, banRemovalArgs, rejectUnexplainedOther } from './ban-input';
import { addTimedMute, clearProfileText, setBanned, setMuted } from './user-actions.service';
import { PROFILE_FIELD_KEYS, type ProfileField } from '$lib/enforcement';

/**
 * The account enforcement actions two pages offer: User Lookup and the user report queue. One copy, so a
 * ban from the queue validates, removes content and refuses exactly as a ban from Lookup does — these
 * were inline in Lookup's `+page.server.ts`, and a second copy is how the two would come to disagree.
 *
 * Gated on `/users` or a named grant, never on the page that spreads them in: reaching either page is an
 * investigation permission, acting on an account is a different one.
 *
 * Failures carry a `scope` the page reads to put the error beside the control that raised it: `account`
 * for ban and mute, `profile` for clearing profile text.
 */
const accountFail = (message: string) => fail(400, { scope: 'account' as const, error: message });
const profileFail = (message: string) => fail(400, { scope: 'profile' as const, error: message });

export const accountEnforcementActions = {
  setMuted: async ({ request, locals }: RequestEvent) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({ muted: z.enum(['true', 'false']) }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const result = await setMuted({
      userId: input.userId,
      muted: input.muted === 'true',
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  addTimedMute: async ({ request, locals }: RequestEvent) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');

    // Either a preset duration or an explicit end (Retool's `muteEnd`); the panel submits one or the
    // other. `until` arrives as an ISO instant, not the raw `datetime-local` value — see the panel.
    const input = parseForm(
      userIdSchema.extend({
        hours: z.coerce.number().positive().max(8760).optional(),
        until: z.coerce.date().optional(),
        reason: z.string().trim().min(1).max(500),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const until =
      input.until ?? (input.hours ? new Date(Date.now() + input.hours * 3_600_000) : null);
    if (!until) return accountFail('Pick a duration or an end date.');
    // A past end time would lift the mute the instant it is applied and read as a silent failure.
    if (until.getTime() <= Date.now()) return accountFail('That end time has already passed.');
    if (until.getTime() > Date.now() + 8760 * 3_600_000)
      return accountFail('A timed mute cannot run more than a year.');
    const result = await addTimedMute({
      userId: input.userId,
      until,
      reason: input.reason,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  clearProfileText: async ({ request, locals }: RequestEvent) => {
    if (!canAccess(locals.user, '/users')) return profileFail('Not permitted.');
    const form = await request.formData();
    const input = parseForm(userIdSchema, form);
    if (typeof input === 'string') return profileFail(input);

    // Checkboxes: absent when unticked, so they are read off the raw FormData rather than the parsed
    // object, which only carries the last value for a repeated name.
    const fields = form
      .getAll('fields')
      .map(String)
      .filter((f): f is ProfileField => (PROFILE_FIELD_KEYS as string[]).includes(f));

    const result = await clearProfileText({
      userId: input.userId,
      fields,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return profileFail(result.error);
    return { success: true };
  },

  setBanned: requiresGrant('user.ban', async ({ request, locals }: RequestEvent) => {
    // reasonCode is validated against the SAME list the main app's endpoint parses. It rejects anything
    // else with a 500 before the ban happens, so an unchecked value here is a ban that silently does not
    // occur.
    const input = parseForm(
      banFieldsSchema.extend({ ...userIdSchema.shape, ban: z.enum(['true', 'false']) }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);
    const unexplained = input.ban === 'true' ? rejectUnexplainedOther(input) : null;
    if (unexplained) return accountFail(unexplained);

    const result = await setBanned({
      userId: input.userId,
      ban: input.ban === 'true',
      reasonCode: input.reasonCode,
      detailsInternal: input.detailsInternal || undefined,
      detailsExternal: input.detailsExternal || undefined,
      ...banRemovalArgs(input, input.ban === 'true'),
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  }),
};
