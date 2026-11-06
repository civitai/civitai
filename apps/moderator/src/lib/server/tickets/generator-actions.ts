import { canAccess } from '../access';
import { resolveRestriction } from '../user-actions.service';
import { generatorPanelFor } from '$lib/tickets/generator-panel';
import { linkedUserFor, restrictionOf } from './account-actions';
import { createTicketGeneratorActions } from './generator-write';
import { ticketNote } from './ticket-note';

/** Rulings on a support ticket's generator restrictions, under the generator restrictions page's grant. */
export const ticketGeneratorActions = createTicketGeneratorActions({
  linkedUser: linkedUserFor(
    generatorPanelFor,
    'This is not an image generator ticket — nothing was changed.'
  ),
  canAct: (user, path) => canAccess(user, path),
  resolveRestriction,
  restrictionOf,
  note: ticketNote,
});
