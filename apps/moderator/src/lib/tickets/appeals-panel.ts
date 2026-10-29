import type { PanelVisibility } from './account-panel';
import type { PanelContext } from './panels';
import { ACCOUNT_RESTRICTION_FEATURE } from './routing';

/** Features whose tickets are about the sender's moderation history, so their appeals are listed. */
export const APPEAL_FEATURES: readonly string[] = [
  'Moderation Decision',
  ACCOUNT_RESTRICTION_FEATURE,
];

export function appealsPanelFor(ticket: PanelContext): PanelVisibility {
  if (ticket.view !== 'moderation' || !APPEAL_FEATURES.includes(ticket.cfFeature?.trim() ?? ''))
    return 'hidden';
  return ticket.civitaiUserId === null ? 'unlinked' : 'panel';
}
