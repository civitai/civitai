import { ticketAccountActions } from './account-actions';
import { ticketAppealActions } from './appeal-actions';
import { ticketFlagAppealActions } from './appeal-flag-actions';
import { ticketQueueAppealActions } from './appeal-queue-actions';
import { ticketRatingActions } from './rating-actions';

/** The form actions of every ticket panel, spread into the moderation page's `actions`. */
export const ticketPanelActions = {
  ...ticketAccountActions,
  ...ticketAppealActions,
  ...ticketQueueAppealActions,
  ...ticketFlagAppealActions,
  ...ticketRatingActions,
};
