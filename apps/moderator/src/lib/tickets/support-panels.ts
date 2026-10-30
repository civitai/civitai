import type { PanelVisibility } from './account-panel';
import type { PanelContext } from './panels';
import { BILLING_MEMBERSHIP_FEATURE } from './routing';

/** The page grant of User Lookup, which serves the sources of these read-only support cards. */
export const USER_LOOKUP_PATH = '/retool/user-lookup';

/** A support-view ticket of one Feature: the card shows with a linked user, a note without one. */
const supportFeaturePanel =
  (feature: string) =>
  (ticket: PanelContext): PanelVisibility => {
    if (ticket.view !== 'support') return 'hidden';
    if (ticket.cfFeature?.trim() !== feature) return 'hidden';
    return ticket.civitaiUserId === null ? 'unlinked' : 'panel';
  };

export const membershipPanelFor = supportFeaturePanel(BILLING_MEMBERSHIP_FEATURE);
