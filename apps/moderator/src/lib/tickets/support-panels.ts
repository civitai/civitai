import {
  BOUNTY_SYSTEM_FEATURE,
  BILLING_MEMBERSHIP_FEATURE,
  BUZZ_RECEIVING_FEATURE,
  COSMETIC_SHOP_FEATURE,
} from './routing';
import { supportFeaturePanel } from './support-feature';

/** Rows shown per list on these cards; the service reads one more so a cut is told from a total. */
export const SUPPORT_ROWS = 10;

export const membershipPanelFor = supportFeaturePanel(BILLING_MEMBERSHIP_FEATURE);
export const shopPanelFor = supportFeaturePanel(COSMETIC_SHOP_FEATURE);
export const payoutsPanelFor = supportFeaturePanel(BUZZ_RECEIVING_FEATURE);
export const bountyPanelFor = supportFeaturePanel(BOUNTY_SYSTEM_FEATURE);
