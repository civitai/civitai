// The decision a site-form appellant is told, read by the main app's in-app notification and the
// moderator app's email. One copy, so the two cannot tell them different things.

export const SITE_APPEAL_CATEGORIES = ['Account', 'Article', 'Model', 'Other'] as const;
export type SiteAppealCategory = (typeof SITE_APPEAL_CATEGORIES)[number];

/** Stored on `Appeal.context` by the main app's submit path. */
export type SiteAppealContext = {
  subject?: string;
  link?: string;
  /** The account's state when the appeal was filed, so the queue still shows it after a lift. */
  restriction?: { banned: boolean; muted: boolean };
};

export const isSiteAppealCategory = (value: unknown): value is SiteAppealCategory =>
  (SITE_APPEAL_CATEGORIES as readonly unknown[]).includes(value);

/**
 * `restored`: the appealed thing is back as it was. An approval that restored nothing (the article
 * was deleted meanwhile) must not say it was restored.
 */
export function siteAppealDecisionText({
  category,
  approved,
  restored,
}: {
  category: SiteAppealCategory;
  approved: boolean;
  restored: boolean;
}): string {
  if (approved) {
    if (category === 'Account')
      return 'We reviewed your appeal and lifted the restriction on your account.';
    if (restored && category === 'Article')
      return 'We reviewed your appeal and restored your article.';
    if (restored && category === 'Model')
      return 'We reviewed your appeal and republished your model.';
    return 'We reviewed your appeal and approved it.';
  }
  switch (category) {
    case 'Account':
      return 'We reviewed your appeal. The restriction on your account stays in place.';
    case 'Article':
      return 'We reviewed your appeal. Your article stays unpublished.';
    case 'Model':
      return 'We reviewed your appeal. Your model stays unpublished.';
    case 'Other':
      return 'We reviewed your appeal. The original decision stands.';
  }
}
