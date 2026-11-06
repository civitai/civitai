import type { PanelVisibility } from './account-panel';
import type { PanelContext } from './panels';

/** The page grant of User Lookup, which serves the sources of the read-only support cards. */
export const USER_LOOKUP_PATH = '/retool/user-lookup';

/**
 * The visibility of a support-view card for the tickets of one Feature (or any of several): the card
 * shows with a linked user, a note without one.
 */
export const supportFeaturePanel = (features: string | readonly string[]) => {
  const accepted = typeof features === 'string' ? [features] : features;
  return (ticket: PanelContext): PanelVisibility => {
    if (ticket.view !== 'support') return 'hidden';
    const feature = ticket.cfFeature?.trim();
    if (!feature || !accepted.includes(feature)) return 'hidden';
    return ticket.civitaiUserId === null ? 'unlinked' : 'panel';
  };
};
