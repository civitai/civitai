import type { RequestHandler } from './$types';
import { requireAccess } from '$lib/server/access';
import { openTicketInView } from '$lib/server/tickets/detail';

export const GET: RequestHandler = async ({ params, locals, url }) => {
  requireAccess(locals.user, url.pathname);
  return openTicketInView('moderation', params.ticketId);
};
