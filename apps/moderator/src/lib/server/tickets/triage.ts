import { canAccess, requireAccess } from '$lib/server/access';
import { isFreshdeskId } from '../freshdesk.service';
import { loadTicketPage, parseTicketQuery } from './list';
import type { TicketView } from '$lib/tickets/routing';

/** Load for both views' triage pages. The open ticket's detail is fetched by the pane on selection, not here. */
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
    // Grants as User Lookup requires them: the `/users` page for mutes and restrictions, `user.ban` for an unban.
    canAccountAct: view === 'moderation' && canAccess(locals.user, '/users'),
    canUnban: view === 'moderation' && !!locals.grants['user.ban'],
    fullBleed: true,
    headerInline: true,
  };
}
