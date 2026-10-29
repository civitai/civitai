import { SENT_TO_SUPPORT_TAG, TICKET_ROUTING, hasSentToSupportTag } from './routing';
import { STATUS } from './statuses';

/** Freshdesk group "Customer Support". */
export const CUSTOMER_SUPPORT_GROUP_ID = 154000246097;

export type EscalationFields = { tags: string[]; group_id: number; status?: number };

/**
 * The fields of the PUT that hands a ticket to support.
 *
 * 🔴 FRESHDESK'S PUT REPLACES THE WHOLE `tags` ARRAY, so the current tags are carried over; sending only
 * the new one would silently drop every tag the ticket has. "Waiting on Mod Lead" becomes Open: a
 * moderation status outranks the sent-to-support tag in routing, so leaving it would keep the ticket in
 * moderation.
 */
export function escalationFields(
  currentTags: readonly string[],
  currentStatus: number
): EscalationFields {
  return {
    tags: hasSentToSupportTag(currentTags)
      ? [...currentTags]
      : [...currentTags, SENT_TO_SUPPORT_TAG],
    group_id: CUSTOMER_SUPPORT_GROUP_ID,
    ...((TICKET_ROUTING.moderationStatuses as readonly number[]).includes(currentStatus)
      ? { status: STATUS.open }
      : {}),
  };
}
