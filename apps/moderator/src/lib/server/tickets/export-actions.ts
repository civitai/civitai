import { queuePersonalDataExport } from '../personal-data-export.service';
import { accountPanelFor } from '$lib/tickets/account-panel';
import { supportAccountPanelFor } from '$lib/tickets/support-account-panel';
import type { PanelContext } from '$lib/tickets/panels';
import { linkedUserFor } from './account-actions';
import { createTicketExportActions } from './export-write';
import { ticketNote } from './ticket-note';

/** Either account panel: the moderation one, or the support one (read-only for every other action). */
const eitherAccountPanel = (ticket: PanelContext) => {
  const moderation = accountPanelFor(ticket);
  return moderation === 'hidden' ? supportAccountPanelFor(ticket) : moderation;
};

export const ticketExportActions = createTicketExportActions({
  linkedUser: linkedUserFor(
    eitherAccountPanel,
    'This ticket has no account panel — nothing was queued.'
  ),
  queue: queuePersonalDataExport,
  note: ticketNote,
});
