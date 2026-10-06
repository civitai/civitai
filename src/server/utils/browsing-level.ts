import type { Context } from '~/server/createContext';
import { resolveBrowsingSettingsAddons } from '~/shared/constants/browsing-settings-addons';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

/**
 * SSR equivalent of the client's effective browsing level.
 *
 * 🔴 It takes no page override, so its client twin is
 * `useViewerBrowsingLevelDebounced` (`forced ?? user`), NOT
 * `useBrowsingLevelDebounced` (`forced ?? override ?? user`). The "keep in sync"
 * below means that one. Syncing it against the page-scoped hook would teach SSR
 * to reproduce an override it has no way to know about.
 *
 * Use when SSR code
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

/**
 * The level plus the addon-derived fields `useQueryImages` adds to every `image.getInfinite`
 * key. An SSR prefetch that omits any of them is keyed differently from the client query, so
 * the page renders its loading state and refetches after hydration (a layout shift). Null
 * when the addons can't be read; the caller should skip the prefetch.
 */
export async function getServerImageQueryFilters(
  browsingLevel: number,
  opts?: { isModerator?: boolean }
) {
  const { getBrowsingSettingAddons } = await import('~/server/services/system-cache');
  const addons = await getBrowsingSettingAddons().catch(() => null);
  if (!addons) return null;
  const { excludedTagIds, disablePoi, disableMinor } = resolveBrowsingSettingsAddons(
    addons,
    browsingLevel,
    opts
  );
  return { browsingLevel, excludedTagIds, disablePoi, disableMinor };
}

/** `getServerBrowsingLevel` for a request whose feature flags are already resolved. */
export const getRequestBrowsingLevel = ({ features, user }: Pick<Context, 'features' | 'user'>) =>
  getServerBrowsingLevel({ canViewNsfw: !!features.canViewNsfw, user });

/**
 * What the viewer may see, with the SFW domain applied.
 *
 * The level itself is client-supplied, as it is for every image listing.
 *
 * ⚠️ A BACKSTOP, NOT THE CONTROL. `applyDomainFeature` (see `trpc.ts`) already
 * clamps `input.browsingLevel` in place on every procedure, and clamps it
 * HARDER — anonymous viewers get PG there, where this gives PG-13. This exists
 * so a surface that shows content the host creator did not choose cannot inherit
 * the host's own admissibility if that middleware is ever bypassed; it must
 * never be read as the statement of the rule.
 */
export const viewerBrowsingLevel = (ctx: Context, requested: number) =>
  ctx.features.isGreen ? requested & sfwBrowsingLevelsFlag : requested;

/**
 * What this domain may be SENT, as opposed to what the viewer asked for.
 *
 * The review queues carry no browsing level by design — an owner has to see what
 * is waiting on them whatever their own settings say — which makes them the one
 * path that hands an above-ceiling asset to a SFW client. Blur is not that
 * control: it is built from the viewer's own level and never reads the domain's.
 */
export const domainServableLevels = (ctx: Context) =>
  ctx.features.isGreen ? sfwBrowsingLevelsFlag : allBrowsingLevelsFlag;

/**
 * The most a request may be served, by who is asking and where: signed out (or a
 * crawler on the SFW domain) PG, signed in on the SFW domain PG/PG-13, and
 * `undefined` where the domain caps nothing. `applyDomainFeature` applies it
 * to every procedure.
 */
export const domainBrowsingLevelCap = ({
  isAuthorized,
  canViewNsfw,
}: {
  isAuthorized: boolean;
  canViewNsfw: boolean;
}) => (!isAuthorized ? publicBrowsingLevelsFlag : !canViewNsfw ? sfwBrowsingLevelsFlag : undefined);

/** A requested level held to a cap. Unset, or with nothing in common with it, becomes the cap. */
export const clampToDomainCap = (requested: number | undefined, cap: number) =>
  (requested ?? 0) & cap || cap;

export type RequestBrowsingLevels = { browsingLevel?: number; preCapBrowsingLevel?: number };

/**
 * Clamps a request's levels to the domain cap, in place. `preCapBrowsingLevel`
 * (a model gallery's level before its own cap, which a sponsored post is served
 * at) takes the same rule, or it would be a way around this one.
 */
export function clampRequestBrowsingLevels(input: RequestBrowsingLevels, cap: number) {
  input.browsingLevel = clampToDomainCap(input.browsingLevel, cap);
  if (input.preCapBrowsingLevel !== undefined)
    input.preCapBrowsingLevel = clampToDomainCap(input.preCapBrowsingLevel, cap);
}
