import type { PageServerLoad } from './$types';
import { ticketAccountActions } from '$lib/server/tickets/account-actions';
import { ticketActions } from '$lib/server/tickets/actions';
import { ticketTriageLoad } from '$lib/server/tickets/triage';

export const load: PageServerLoad = ({ locals, url }) =>
  ticketTriageLoad('moderation', { url, locals });

export const actions = { ...ticketActions('moderation'), ...ticketAccountActions };
