import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { TOOL_REQUEST_STATUSES } from '$lib/assistant/types';
import { listToolRequests, resolveToolRequest } from '$lib/server/assistant/store';
import { canAccess, canSeeAddresses } from '$lib/server/access';
import { redactAddresses } from '$lib/server/redact-addresses';
import { moderatorDbStatus } from '$lib/moderator-db-status';
import { assistantStoreMessage } from '../store-status';

/**
 * What the assistant has asked its maintainers for, and their answers. Every assistant user sees the
 * list; the conversation that prompted a request is another moderator's chat, so it is attached only
 * for the moderator who asked and for holders of the audit page. Addresses in another moderator's
 * request are redacted for a viewer who could not read them in User Lookup.
 */
export const load: PageServerLoad = async ({ locals }) => {
  const auditor = canAccess(locals.user, '/assistant/audit');
  const seesAddresses = canSeeAddresses(locals);
  try {
    const requests = await listToolRequests();
    return {
      storeError: null,
      canResolve: auditor,
      requests: requests.map((r) => {
        const mine = r.moderatorId === locals.user.id;
        const text = mine || seesAddresses ? (t: string) => t : redactAddresses;
        return {
          ...r,
          need: text(r.need),
          reason: text(r.reason),
          example: r.example && text(r.example),
          mine,
          conversation:
            auditor || mine
              ? r.conversation.map((c) => ({
                  prompt: text(c.prompt),
                  answer: c.answer && text(c.answer),
                }))
              : null,
        };
      }),
    };
  } catch (e) {
    console.error('[assistant] tool requests unavailable', e);
    return {
      storeError: assistantStoreMessage(moderatorDbStatus(e)),
      canResolve: false,
      requests: [],
    };
  }
};

const resolveSchema = z.object({
  id: z.coerce.number().int().positive(),
  status: z.enum(TOOL_REQUEST_STATUSES),
  response: z
    .string()
    .trim()
    .max(4000)
    .transform((s) => s || null),
});

export const actions: Actions = {
  // The audit grant, not the assistant page: every assistant user can read this list.
  resolve: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/assistant/audit'))
      return fail(403, { error: 'Only holders of the assistant audit can answer requests.' });
    const parsed = resolveSchema.safeParse(Object.fromEntries(await request.formData()));
    if (!parsed.success) return fail(400, { error: 'Invalid answer.' });
    const ok = await resolveToolRequest({ ...parsed.data, resolverId: locals.user.id });
    return ok ? { success: true } : fail(404, { error: 'No such request.' });
  },
};
