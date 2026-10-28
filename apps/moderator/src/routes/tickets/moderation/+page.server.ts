import type { PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { listTickets } from '$lib/server/tickets/list';

export const load: PageServerLoad = ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);
  return {
    // Not awaited: SvelteKit streams it, so the page shell renders while Freshdesk is searched.
    tickets: listTickets('moderation', { includeEmail: !!locals.grants['decisions.support.pii'] }),
    canSeeEmail: !!locals.grants['decisions.support.pii'],
  };
};
