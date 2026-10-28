import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/access';
import { openTicketInView } from '$lib/server/tickets/detail';

// The pre-triage address of a ticket: it now opens in the list, which is where its detail lives.
export const GET: RequestHandler = async ({ params, locals, url }) => {
  requireAccess(locals.user, url.pathname);
  return openTicketInView('moderation', params.ticketId);
};
