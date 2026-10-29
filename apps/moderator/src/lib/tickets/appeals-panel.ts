import type { PanelVisibility } from './account-panel';
import type { PanelContext } from './panels';
import { ACCOUNT_RESTRICTION_FEATURE } from './routing';

/** Features whose tickets are about the sender's moderation history, so their appeals are listed. */
export const APPEAL_FEATURES: readonly string[] = [
  'Moderation Decision',
  ACCOUNT_RESTRICTION_FEATURE,
];

/** Router topics that mean the same for a ticket with no feature. Edit to add one. */
export const APPEAL_TOPICS: readonly string[] = ['image-moderation-appeal', 'nsfw-moderation'];

export function appealsPanelFor(ticket: PanelContext): PanelVisibility {
  if (ticket.view !== 'moderation') return 'hidden';
  const aboutAppeals =
    APPEAL_FEATURES.includes(ticket.cfFeature?.trim() ?? '') ||
    (!!ticket.routerTopic && APPEAL_TOPICS.includes(ticket.routerTopic));
  if (!aboutAppeals) return 'hidden';
  return ticket.civitaiUserId === null ? 'unlinked' : 'panel';
}
