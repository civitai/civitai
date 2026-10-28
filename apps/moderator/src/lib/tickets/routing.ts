import { STATUS } from './statuses';

export type TicketView = 'moderation' | 'support';

export const isTicketView = (v: unknown): v is TicketView => v === 'moderation' || v === 'support';

export const ACCOUNT_RESTRICTION_FEATURE = 'Account Restriction or Banned Account';

/**
 * Which tickets belong to the moderation view. Everything else is support's. Edit this constant to move
 * a bucket between the views; nothing else encodes the rule.
 *
 * Uncertain buckets (Content Related Issue, User Report, abuse-report, account-issue) stay in support.
 */
export const TICKET_ROUTING = {
  /** Freshdesk `cf_feature` values that mean a moderator handles the ticket. */
  moderationFeatures: [ACCOUNT_RESTRICTION_FEATURE, 'Moderation Decision'],
  moderationStatuses: [STATUS.waitingOnMod],
  /** Router topics that count ONLY for a ticket that has no `cf_feature`. */
  fallbackTopics: ['nsfw-moderation', 'image-moderation-appeal'],
} as const;

/** Freshdesk tag that hands a ticket to support, unless its status is a moderation status. */
export const SENT_TO_SUPPORT_TAG = 'sent-to-support';

/** Whether `tags` carries the sent-to-support tag. Freshdesk treats tags case-insensitively. */
export const hasSentToSupportTag = (tags: readonly string[] | undefined): boolean =>
  !!tags?.some((t) => t.toLowerCase() === SENT_TO_SUPPORT_TAG);

export type RoutingInput = {
  cfFeature: string | null | undefined;
  status: number;
  routerTopic: string | null | undefined;
  tags?: readonly string[];
};

const isIn = (list: readonly (string | number)[], value: string | number) => list.includes(value);

/**
 * Precedence: moderation status, then the sent-to-support tag, then `cf_feature`, then the router's topic
 * (only for a ticket with no feature). A moderation status outranks the tag because that is how support
 * hands an escalated ticket back.
 */
export function routeTicket({ cfFeature, status, routerTopic, tags }: RoutingInput): TicketView {
  if (isIn(TICKET_ROUTING.moderationStatuses, status)) return 'moderation';
  if (hasSentToSupportTag(tags)) return 'support';
  const feature = cfFeature?.trim() ?? '';
  if (feature && isIn(TICKET_ROUTING.moderationFeatures, feature)) return 'moderation';
  if (!feature && routerTopic && isIn(TICKET_ROUTING.fallbackTopics, routerTopic))
    return 'moderation';
  return 'support';
}
