import type { PanelVisibility } from './account-panel';
import type { PanelContext } from './panels';
import { ACCOUNT_LOGIN_FEATURE, EMAIL_CHANGE_FEATURE } from './routing';

/**
 * Support-view tickets about signing in or changing the email get the sender's account, read-only.
 * Its own predicate, not a widened `accountPanelFor`: that one gates the account WRITE actions, which
 * must stay moderation-only.
 */
export function supportAccountPanelFor(ticket: PanelContext): PanelVisibility {
  if (ticket.view !== 'support') return 'hidden';
  const feature = ticket.cfFeature?.trim();
  if (feature !== ACCOUNT_LOGIN_FEATURE && feature !== EMAIL_CHANGE_FEATURE) return 'hidden';
  return ticket.civitaiUserId === null ? 'unlinked' : 'panel';
}
