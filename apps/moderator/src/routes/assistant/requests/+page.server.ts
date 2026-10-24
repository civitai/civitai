import type { PageServerLoad } from './$types';
import { listToolRequests } from '$lib/server/assistant/store';
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
    return { storeError: assistantStoreMessage(moderatorDbStatus(e)), requests: [] };
  }
};
