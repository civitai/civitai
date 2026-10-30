import { ticketAccountActions } from './account-actions';
import { ticketAppealActions } from './appeal-actions';
import { ticketFlagAppealActions } from './appeal-flag-actions';
import { ticketQueueAppealActions } from './appeal-queue-actions';
import { ticketGeneratorActions } from './generator-actions';
import { ticketLoraActions } from './lora-actions';
import { ticketRatingActions } from './rating-actions';

/**
 * The form actions of the moderation view's ticket panels, spread into its page's `actions`. Each is
 * refused for a ticket its panel does not show on (a support ticket among them), not just left unlisted.
 */
export const moderationPanelActions = {
  ...ticketAccountActions,
  ...ticketAppealActions,
  ...ticketQueueAppealActions,
  ...ticketFlagAppealActions,
  ...ticketRatingActions,
};

/** The support view's, spread into the support page's `actions`. */
export const supportPanelActions = {
  ...ticketGeneratorActions,
  ...ticketLoraActions,
};
