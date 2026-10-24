import type { SiteAppealCategory } from '@civitai/shared/site-appeal';

export type SiteAppealQueue = {
  slug: string;
  category: SiteAppealCategory;
  label: string;
  title: string;
};

/** One queue per category, each its own page so each is granted on its own. */
export const SITE_APPEAL_QUEUES = [
  { slug: 'account', category: 'Account', label: 'Account', title: 'Appeals: Account' },
  { slug: 'articles', category: 'Article', label: 'Articles', title: 'Appeals: Articles' },
  { slug: 'models', category: 'Model', label: 'Models', title: 'Appeals: Models' },
  { slug: 'other', category: 'Other', label: 'Other', title: 'Appeals: Other' },
] as const satisfies readonly SiteAppealQueue[];

export const siteAppealQueuePath = (slug: string) => `/appeals/${slug}`;
export const siteAppealCountKey = (category: SiteAppealCategory) => `siteAppeals${category}`;

export const siteAppealQueueForSlug = (slug: string): SiteAppealQueue | undefined =>
  SITE_APPEAL_QUEUES.find((q) => q.slug === slug);

/** What an approval lifted, as the service reports it and the queue labels it. */
export type SiteAppealLift = 'ban' | 'mute' | 'article' | 'model';

export const BAN_PERMISSION_NEEDED = 'Approving lifts a ban, which needs the Ban permission.';

// A ban unpublishes everything its account owns; putting one item back while the ban stands would
// publish a banned account's content.
export const OWNER_BANNED =
  'The owner is banned. Decide their account appeal first, or reject this one.';

/** The server refuses this approval; the queue reads the same rule so it does not offer it. */
export const approvalNeedsBanGrant = (bannedAt: Date | string | null, canBan: boolean) =>
  bannedAt !== null && !canBan;
