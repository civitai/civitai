import { canAccess, requireAccess } from '$lib/server/access';
import { isFreshdeskId } from '../freshdesk.service';
import { loadTicketPage, parseTicketQuery } from './list';
import type { TicketView } from '$lib/tickets/routing';

/**
 * The load of both views' triage pages: one filtered page from the snapshot, and the ticket named by
 * `?ticket=` when it belongs to the view but is not on that page. The conversation is not here; the open
 * ticket's detail is fetched when it is selected.
 */
export async function ticketTriageLoad(
  view: TicketView,
  { url, locals }: { url: URL; locals: App.Locals }
) {
  requireAccess(locals.user, url.pathname);
  const asked = url.searchParams.get('ticket');
  const pinnedId = asked && isFreshdeskId(asked) ? asked : undefined;

  const result = await loadTicketPage(view, parseTicketQuery(url), { pinnedId });
  const selectedMissing =
    pinnedId &&
    result.status === 'ok' &&
    !result.pinned &&
    !result.items.some((t) => t.id === pinnedId)
      ? pinnedId
      : null;

  return {
    view,
    result,
    selectedMissing,
    canReply: !!locals.grants['tickets.reply'],
    canEscalate: view === 'moderation' && !!locals.grants['tickets.escalate'],
    // The account actions keep the grants they need in User Lookup: the `/users` page for mutes and
    // restrictions, `user.ban` for an unban. They are on the moderation view only.
    canAccountAct: view === 'moderation' && canAccess(locals.user, '/users'),
    canUnban: view === 'moderation' && !!locals.grants['user.ban'],
    fullBleed: true,
    headerInline: true,
  };
}
