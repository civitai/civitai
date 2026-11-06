import { ACCOUNT_LOGIN_FEATURE, EMAIL_CHANGE_FEATURE } from './routing';
import { supportFeaturePanel } from './support-feature';

/**
 * Support-view tickets about signing in or changing the email get the sender's account, read-only.
 * Its own predicate, not a widened `accountPanelFor`: that one gates the account WRITE actions, which
 * must stay moderation-only.
 */
export const supportAccountPanelFor = supportFeaturePanel([
  ACCOUNT_LOGIN_FEATURE,
  EMAIL_CHANGE_FEATURE,
]);
