import { SENT_TO_SUPPORT_TAG, hasSentToSupportTag } from './routing';

/** Freshdesk group "Customer Support". */
export const CUSTOMER_SUPPORT_GROUP_ID = 154000246097;

const WAITING_ON_MOD_LEAD = 8;
const OPEN = 2;

export type EscalationFields = { tags: string[]; group_id: number; status?: number };

/**
 * The fields of the PUT that hands a ticket to support.
 *
 * 🔴 FRESHDESK'S PUT REPLACES THE WHOLE `tags` ARRAY, so the current tags are carried over; sending only
 * the new one would silently drop every tag the ticket has. "Waiting on Mod Lead" would leave the ticket
 * waiting on a role support does not have, so it becomes Open; any other status is left alone.
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
    ...(currentStatus === WAITING_ON_MOD_LEAD ? { status: OPEN } : {}),
  };
}
