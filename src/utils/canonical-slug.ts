import { slugit } from '~/utils/string-helpers';

/**
 * Destination for the canonical `/{basePath}/{id}/{slug}` redirect, or null when the current URL
 * is already canonical.
 *
 * Returns null when the canonical slug is empty — slugit() strips all non-Latin-alphanumeric
 * chars (strict mode), so CJK/Cyrillic/emoji/dots-only titles slugify to ''. Redirecting to
 * `/{basePath}/<id>/` (empty slug) gets trailing-slash-normalized back to `/{basePath}/<id>`,
 * which never matches '' and loops forever (ERR_TOO_MANY_REDIRECTS).
 */
export function getCanonicalSlugDestination({
  basePath,
  id,
  title,
  currentSlug,
  queryString = '',
}: {
  basePath: string;
  id: number;
  title: string;
  currentSlug?: string;
  queryString?: string;
}): string | null {
  const correctSlug = slugit(title);
  if (!correctSlug || currentSlug === correctSlug) return null;
  return `${basePath}/${id}/${correctSlug}${queryString}`;
}
