import type { SearchIndexKey } from '~/components/Search/search.types';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

/**
 * The search target a dropdown should DEFAULT to, given where it was derived from (the URL
 * section, or a caller's starting index).
 *
 * While image search is off (`imageSearch`), an `images` default lands the user on a target that
 * can only show a maintenance notice, so it resolves to `models` instead. Every other target, and
 * `images` while image search is on, passes through unchanged.
 *
 * This decides only the DEFAULT. Picking Images explicitly from a selector still selects it, and
 * the caller still shows its maintenance notice for that pick — do not route a user's own choice
 * through here.
 *
 * `supported`, when given, is the set the caller is limited to: `models` is substituted only when
 * it is in that set, so a caller that cannot search models keeps its own target (and its notice)
 * rather than being moved onto an index it never declared.
 */
export function resolveSearchTarget(
  target: SearchIndexKey,
  features: Pick<FeatureAccess, 'imageSearch'>,
  supported?: readonly SearchIndexKey[]
): SearchIndexKey {
  if (target !== 'images' || features.imageSearch) return target;
  if (supported && !supported.includes('models')) return target;
  return 'models';
}
