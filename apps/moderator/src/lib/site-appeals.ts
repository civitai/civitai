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
