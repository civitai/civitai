import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * SSR equivalent of the client's effective browsing level
 * (`BrowsingLevelProvider` → `useBrowsingLevelDebounced`). Use when SSR code
 * must reproduce a browsing-level-dependent client query key — e.g. resolving
 * the browsing-settings addons to prefetch `image.getInfinite` so a feed/carousel
 * hydrates without a layout shift.
 *
 * Mirrors the cap rules in
 * [BrowsingLevelProvider](../../components/BrowsingLevel/BrowsingLevelProvider.tsx)
 * and the `applyDomainFeature` middleware in [trpc](../trpc.ts) — keep in sync:
 *   - anonymous (any domain)     → public (PG)
 *   - logged-in on green domain  → sfw (PG + PG-13)
 *   - logged-in on blue/red      → the user's saved preference (public if nsfw off)
 *
 * `canViewNsfw` is the per-request feature flag: false on the green (SFW) domain,
 * true on blue/red for authorized users — the same signal the client provider reads.
 */
export function getServerBrowsingLevel({
  canViewNsfw,
  user,
}: {
  canViewNsfw: boolean;
  user?: { showNsfw?: boolean | null; browsingLevel?: number | null } | null;
}): number {
  // Green (SFW) domain forces a cap that overrides the saved preference.
  if (!canViewNsfw) return user ? sfwBrowsingLevelsFlag : publicBrowsingLevelsFlag;
  // Blue/red: honor the user's saved preference; fall back to public when nsfw is off.
  return user?.showNsfw && user.browsingLevel ? user.browsingLevel : publicBrowsingLevelsFlag;
}
