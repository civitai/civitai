// The decision a site-form appellant is told, read by the main app's in-app notification and the
// moderator app's email. One copy, so the two cannot tell them different things.
import { AppealCategory } from '@civitai/db-schema/enums';

export type SiteAppealCategory = AppealCategory;

/** Where the appellant reads their appeals and every decision, including the moderator's message. */
export const SITE_APPEAL_PATH = '/appeal';
export const SITE_APPEAL_CATEGORIES = Object.values(AppealCategory);

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
 * `restored`: the approval put back what was appealed. An approval that lifted nothing (the article
 * was deleted meanwhile, the ban was already lifted) must not say it did. A rejection names the
 * decision, never the current state, which may have moved since.
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
    if (restored && category === 'Account')
      return 'We reviewed your appeal and lifted the restriction on your account.';
    if (restored && category === 'Article')
      return 'We reviewed your appeal and restored your article.';
    if (restored && category === 'Model')
      return 'We reviewed your appeal and republished your model.';
    return 'We reviewed your appeal and approved it.';
  }
  switch (category) {
    case 'Account':
      return 'We reviewed your appeal. The decision on your account stands.';
    case 'Article':
      return 'We reviewed your appeal. The decision to unpublish your article stands.';
    case 'Model':
      return 'We reviewed your appeal. The decision to unpublish your model stands.';
    case 'Other':
      return 'We reviewed your appeal. The original decision stands.';
  }
}
