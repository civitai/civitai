import { dbRead } from '../db';
import { canAccess } from '../access';
import { accountEnforcementActions } from '../account-actions';
import { getTicketDetail, isFreshdeskId } from '../freshdesk.service';
import { revokeTimedMute, resolveRestriction } from '../user-actions.service';
import { accountPanelFor } from '$lib/tickets/account-panel';
import type { PanelContext } from '$lib/tickets/panels';
import type { PanelVisibility } from '$lib/tickets/account-panel';
import { linkedCivitaiUserId, resolveTicketView } from './detail';
import { createTicketAccountActions } from './account-write';
import type { LinkedUser } from './panel-write';
import { ticketNote } from './ticket-note';

/**
 * The user a ticket links to, read live right before a write. The ticket must still be one the panel
 * the action belongs to shows for (`visibility`, the same rule that decides whether the page shows it).
 */
export function linkedUserFor(
  visibility: (ticket: PanelContext) => PanelVisibility,
  notShown: string
) {
  return (ticketId: string): Promise<LinkedUser> => readLinkedUser(ticketId, visibility, notShown);
}

/** For the account panel: a moderation ticket about an account. */
export const linkedUser = linkedUserFor(
  accountPanelFor,
  'This is not an account ticket — nothing was changed.'
);

async function readLinkedUser(
  ticketId: string,
  visibility: (ticket: PanelContext) => PanelVisibility,
  notShown: string
): Promise<LinkedUser> {
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
  const panel = visibility({
    view: 'moderation',
    cfFeature: res.ticket.cfFeature,
    routerTopic: routed?.topic ?? null,
    civitaiUserId: userId,
  });
  if (panel === 'hidden') return { status: 'refused', code: 409, message: notShown };
  return { status: 'ok', userId };
}

/** Lifting bans and mutes and ruling on restrictions only; banning, new restrictions and strikes are not offered from a ticket. */
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
  note: ticketNote,
});
