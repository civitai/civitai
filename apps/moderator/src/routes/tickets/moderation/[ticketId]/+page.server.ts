import type { PageServerLoad } from './$types';
import { ticketActions } from '$lib/server/tickets/actions';
import { requireAccess } from '$lib/server/access';
import { loadTicketDetail } from '$lib/server/tickets/detail';

export const load: PageServerLoad = ({ params, locals, url }) => {
  requireAccess(locals.user, url.pathname);
  return loadTicketDetail('moderation', params.ticketId, locals);
};

export const actions = ticketActions('moderation');
