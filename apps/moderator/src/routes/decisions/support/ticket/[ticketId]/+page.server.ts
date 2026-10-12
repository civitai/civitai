import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getSupportTicket, isTicketId, supportVersion } from '$lib/server/decision-sources/support';
import { getTicketDescription } from '$lib/server/freshdesk.service';

export const load: PageServerLoad = async ({ params, url, locals }) => {
  if (!isTicketId(params.ticketId)) throw error(404, 'No such ticket.');
  // 🔴 Decided BEFORE the read: without the grant the email column is not in the statement at all.
  const includeEmail = !!locals.grants['decisions.support.pii'];

  try {
    const { version, overridden } = await supportVersion(url.searchParams.get('version'));
    if (!version) throw error(404, 'The support-ticket router has not routed any tickets yet.');
    const ticket = await getSupportTicket({ version, ticketId: params.ticketId, includeEmail });
    if (!ticket)
      throw error(404, `Ticket ${params.ticketId} was not routed under router version ${version}.`);
    return {
      ticket,
      version,
      overridden,
      canSeeEmail: includeEmail,
      // Not awaited: SvelteKit streams it, so a slow Freshdesk delays the body panel, not the page.
      description: getTicketDescription(params.ticketId),
    };
  } catch (e) {
    if (typeof (e as { status?: unknown }).status === 'number') throw e;
    console.error('[decisions] support ticket load failed', e);
    throw error(503, "Could not read the support-ticket router's data.");
  }
};
