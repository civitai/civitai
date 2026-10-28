import { dbRead } from '../db';
import { canAccess } from '../access';
import { accountEnforcementActions } from '../account-actions';
import { addPrivateNote } from '../freshdesk-write.service';
import { getTicketDetail, isFreshdeskId } from '../freshdesk.service';
import { revokeTimedMute, resolveRestriction } from '../user-actions.service';
import { accountPanelFor } from '$lib/tickets/account-panel';
import { plainTextToHtml } from '$lib/tickets/reply-html';
import { linkedCivitaiUserId, resolveTicketView } from './detail';
import { createTicketAccountActions, type LinkedUser } from './account-write';

/**
 * The user a ticket links to, read live right before a write. The ticket must still be a moderation
 * ticket about an account: the same rule that decides whether the page shows the panel.
 */
export async function linkedUser(ticketId: string): Promise<LinkedUser> {
  if (!isFreshdeskId(ticketId)) return { status: 'refused', code: 404, message: 'No such ticket.' };
  const res = await getTicketDetail(ticketId);
  if (res.status !== 'found')
    return {
      status: 'refused',
      code: 503,
      message: `Could not check the ticket (${res.reason}) — nothing was changed.`,
    };
  const { routesTo, routed } = await resolveTicketView(ticketId, res.ticket);
  if (routesTo !== 'moderation')
    return {
      status: 'refused',
      code: 409,
      message: `This ticket now belongs to the ${routesTo} view — nothing was changed.`,
    };
  const userId = await linkedCivitaiUserId(res.ticket, routed);
  const panel = accountPanelFor({
    view: 'moderation',
    cfFeature: res.ticket.cfFeature,
    routerTopic: routed?.topic ?? null,
    civitaiUserId: userId,
  });
  if (panel === 'hidden')
    return {
      status: 'refused',
      code: 409,
      message: 'This is not an account ticket — nothing was changed.',
    };
  return { status: 'ok', userId };
}

/**
 * `?/accountUnban`, `?/accountUnmute`, `?/accountLiftTimedMute` and `?/accountResolveRestriction` for the
 * moderation list page. Lifting only: banning, new restrictions and strikes are not offered from a ticket.
 */
export const ticketAccountActions = createTicketAccountActions({
  linkedUser,
  inner: accountEnforcementActions,
  canAct: (user) => canAccess(user, '/users'),
  revokeTimedMute,
  resolveRestriction,
  restrictionOf: async (id) =>
    (await dbRead
      .selectFrom('UserRestriction')
      .select(['userId', 'type', 'status'])
      .where('id', '=', id)
      .executeTakeFirst()) ?? null,
  note: (id, text) => addPrivateNote(id, plainTextToHtml(text) ?? ''),
});
