import type { AppealCategory } from '~/shared/utils/prisma/enums';

/** The old third-party appeal form, kept for everyone the on-site form is not enabled for yet. */
export const LEGACY_APPEAL_SLUG = 'content-appeal';
export const LEGACY_APPEAL_PATH = `/content/${LEGACY_APPEAL_SLUG}`;

/**
 * Where an appeal link points. Behind `siteAppealForm`, the on-site form, preselected when the
 * caller knows what is being appealed; otherwise the old form, since `/appeal` is a 404 without the
 * flag.
 */
export function siteAppealHref(
  enabled: boolean,
  target?: { category: AppealCategory; id?: number }
): string {
  if (!enabled) return LEGACY_APPEAL_PATH;
  if (!target) return '/appeal';
  return siteAppealPathFromQuery({ category: target.category, id: target.id?.toString() });
}

/** `/appeal` with a deep link's `category` and `id` carried over. The page validates them. */
export function siteAppealPathFromQuery(query: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  for (const key of ['category', 'id'] as const) {
    const value = query[key];
    if (typeof value === 'string' && value) params.set(key, value);
  }
  const search = params.toString();
  return search ? `/appeal?${search}` : '/appeal';
}
