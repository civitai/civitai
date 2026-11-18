import {
  MOD_LEAD_REVIEW_TAG,
  PRIVACY_REQUEST_TAG,
  SENT_TO_SUPPORT_TAG,
  TICKET_ROUTING,
  hasTag,
} from './routing';
import { STATUS } from './statuses';

/** Freshdesk group "Customer Support". */
export const CUSTOMER_SUPPORT_GROUP_ID = 154000246097;

export type EscalationFields = { tags: string[]; group_id?: number; status?: number };

/** 🔴 FRESHDESK'S PUT REPLACES THE WHOLE `tags` ARRAY, so every hand-off carries the current tags over;
 *  sending only the new one would silently drop every tag the ticket has. */
const withTag = (currentTags: readonly string[], tag: string): string[] =>
  hasTag(currentTags, tag) ? [...currentTags] : [...currentTags, tag];

/**
 * The fields of the PUT that hands a ticket to support. "Waiting on Mod Lead" becomes Open: a
 * moderation status outranks the sent-to-support tag in routing, so leaving it would keep the ticket in
 * moderation. The mod-lead tag goes too, or the mod lead's watch would still count the ticket as theirs.
 */
export function escalationFields(
  currentTags: readonly string[],
  currentStatus: number
): EscalationFields {
  const kept = currentTags.filter((t) => t.toLowerCase() !== MOD_LEAD_REVIEW_TAG);
  return {
    tags: withTag(kept, SENT_TO_SUPPORT_TAG),
    group_id: CUSTOMER_SUPPORT_GROUP_ID,
    ...((TICKET_ROUTING.moderationStatuses as readonly number[]).includes(currentStatus)
      ? { status: STATUS.open }
      : {}),
  };
}

/**
 * Hands a ticket to Legal. Freshdesk has no Legal group, so the group is left alone: the tag is the
 * routing key. Legal requires that this hand-off never resolves, closes or lowers the priority of a
 * ticket, so never add a resolving status or `priority` here.
 */
export const privacyFields = (currentTags: readonly string[]): EscalationFields => ({
  tags: withTag(currentTags, PRIVACY_REQUEST_TAG),
  status: STATUS.waitingOnDev,
});

/** Hands a ticket to the mod lead. The tag tells the mod lead's watch this apart from support's hand-backs, which also set status 8. */
export const modLeadFields = (currentTags: readonly string[]): EscalationFields => ({
  tags: withTag(currentTags, MOD_LEAD_REVIEW_TAG),
  status: STATUS.waitingOnMod,
});

/** Legal's acknowledgment, verbatim (Legal, 2026-11-17). Never edit it here without Legal's text. */
export const PRIVACY_ACK_TEXT =
  "Thanks for your request. We've passed it to our privacy team, and we'll reply to this email.\n\nCivitai Support";
