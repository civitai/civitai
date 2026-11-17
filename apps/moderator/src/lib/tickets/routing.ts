import { STATUS } from './statuses';

export type TicketView = 'moderation' | 'support';

/** Where a ticket belongs. `legal` is no view: Legal works those tickets in Freshdesk, so neither list shows them. */
export type TicketRoute = TicketView | 'legal';

export const isTicketView = (v: unknown): v is TicketView => v === 'moderation' || v === 'support';

export const ACCOUNT_RESTRICTION_FEATURE = 'Account Restriction or Banned Account';
export const CONTENT_RELATED_FEATURE = 'Content Related Issue';
export const IMAGE_GENERATOR_FEATURE = 'Image Generator';
export const LORA_TRAINER_FEATURE = 'LoRA Trainer';
export const BILLING_MEMBERSHIP_FEATURE = 'Billing or Membership';
export const COSMETIC_SHOP_FEATURE = 'Cosmetic Shop';
export const BUZZ_RECEIVING_FEATURE = 'Buzz (Receiving)';
export const BOUNTY_SYSTEM_FEATURE = 'Bounty System';
export const ACCOUNT_LOGIN_FEATURE = 'Account Login';
export const EMAIL_CHANGE_FEATURE = 'Email Change';

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

/** Freshdesk tag that hands a ticket to Legal. Legal's intake watch keys on this tag alone. */
export const PRIVACY_REQUEST_TAG = 'privacy-request';

/** Freshdesk tag that marks a ticket a moderator sent to the mod lead, as opposed to support handing it back. */
export const MOD_LEAD_REVIEW_TAG = 'mod-lead-review';

/** Freshdesk treats tags case-insensitively. */
export const hasTag = (tags: readonly string[] | undefined, tag: string): boolean =>
  !!tags?.some((t) => t.toLowerCase() === tag);

export const hasSentToSupportTag = (tags: readonly string[] | undefined): boolean =>
  hasTag(tags, SENT_TO_SUPPORT_TAG);

export type RoutingInput = {
  cfFeature: string | null | undefined;
  status: number;
  routerTopic: string | null | undefined;
  tags?: readonly string[];
};

const isIn = (list: readonly (string | number)[], value: string | number) => list.includes(value);

/**
 * Precedence: the privacy tag (Legal owns the ticket whatever else it carries), then moderation
 * status, then the sent-to-support tag, then `cf_feature`, then the router's topic (only for a ticket
 * with no feature). A moderation status outranks the sent-to-support tag because that is how support
 * hands an escalated ticket back.
 */
export function routeTicket({ cfFeature, status, routerTopic, tags }: RoutingInput): TicketRoute {
  if (hasTag(tags, PRIVACY_REQUEST_TAG)) return 'legal';
  if (isIn(TICKET_ROUTING.moderationStatuses, status)) return 'moderation';
  if (hasSentToSupportTag(tags)) return 'support';
  const feature = cfFeature?.trim() ?? '';
  if (feature && isIn(TICKET_ROUTING.moderationFeatures, feature)) return 'moderation';
  if (!feature && routerTopic && isIn(TICKET_ROUTING.fallbackTopics, routerTopic))
    return 'moderation';
  return 'support';
}
