import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canAccess } from '$lib/server/access';
import { loadTicketPayload } from '$lib/server/tickets/detail';
import { isTicketView } from '$lib/tickets/routing';

/**
 * The open ticket's description and conversation, fetched when a ticket is selected. 🔴 `/api/*` is exempt
 * from the global route gate, so this checks the grant of the page the ticket is opened under, and the
 * loader refuses (404) a ticket that routes to the other view: the page grants are per view.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
  const view = url.searchParams.get('view');
  if (!isTicketView(view)) error(400, 'Bad view.');
  if (!locals.user) error(403, 'Not signed in.');
  if (!canAccess(locals.user, `/tickets/${view}`))
    error(403, 'You do not have access to this page.');

  const res = await loadTicketPayload(view, params.id, {
    canSeeEmail: !!locals.grants['decisions.support.pii'],
  });
  if (res.status === 'refused') error(res.code, res.message);
  return json(res, { headers: { 'cache-control': 'private, no-store' } });
};
