import type { PanelVisibility } from './account-panel';
import type { PanelContext } from './panels';
import {
  BILLING_MEMBERSHIP_FEATURE,
  BUZZ_RECEIVING_FEATURE,
  COSMETIC_SHOP_FEATURE,
} from './routing';

/** The page grant of User Lookup, which serves the sources of these read-only support cards. */
export const USER_LOOKUP_PATH = '/retool/user-lookup';

/** Rows shown per list on these cards; the service reads one more so a cut is told from a total. */
export const SUPPORT_ROWS = 10;

/** A support-view ticket of one Feature: the card shows with a linked user, a note without one. */
const supportFeaturePanel =
  (feature: string) =>
  (ticket: PanelContext): PanelVisibility => {
    if (ticket.view !== 'support') return 'hidden';
    if (ticket.cfFeature?.trim() !== feature) return 'hidden';
    return ticket.civitaiUserId === null ? 'unlinked' : 'panel';
  };

export const membershipPanelFor = supportFeaturePanel(BILLING_MEMBERSHIP_FEATURE);
export const shopPanelFor = supportFeaturePanel(COSMETIC_SHOP_FEATURE);
export const payoutsPanelFor = supportFeaturePanel(BUZZ_RECEIVING_FEATURE);
