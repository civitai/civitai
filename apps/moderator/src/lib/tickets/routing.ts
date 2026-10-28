export type TicketView = 'moderation' | 'support';

/**
 * Which tickets belong to the moderation view. Everything else is support's. Edit this constant to move
 * a bucket between the views; nothing else encodes the rule.
 *
 * Uncertain buckets (Content Related Issue, User Report, abuse-report, account-issue) stay in support.
 */
export const TICKET_ROUTING = {
  /** Freshdesk `cf_feature` values that mean a moderator handles the ticket. */
  moderationFeatures: ['Account Restriction or Banned Account', 'Moderation Decision'],
  /** Freshdesk status ids that hand a ticket to moderation: 8 "Waiting on Mod Lead". */
  moderationStatuses: [8],
  /** Router topics that count ONLY for a ticket that has no `cf_feature`. */
  fallbackTopics: ['nsfw-moderation', 'image-moderation-appeal'],
} as const;

export type RoutingInput = {
  cfFeature: string | null | undefined;
  status: number;
  routerTopic: string | null | undefined;
};

const isIn = (list: readonly (string | number)[], value: string | number) => list.includes(value);

/**
 * The view a ticket belongs to. A `cf_feature` an agent set always wins over the router's guess, so a
 * support-labelled ticket stays in support even when the router thinks it is about moderation.
 */
export function routeTicket({ cfFeature, status, routerTopic }: RoutingInput): TicketView {
  const feature = cfFeature?.trim() ?? '';
  if (feature && isIn(TICKET_ROUTING.moderationFeatures, feature)) return 'moderation';
  if (isIn(TICKET_ROUTING.moderationStatuses, status)) return 'moderation';
  if (!feature && routerTopic && isIn(TICKET_ROUTING.fallbackTopics, routerTopic))
    return 'moderation';
  return 'support';
}
