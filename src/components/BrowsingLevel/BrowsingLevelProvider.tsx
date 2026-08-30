import { useDebouncedValue } from '@mantine/hooks';
import React, { createContext, useContext, useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  BROWSING_LEVEL_FALLBACK,
  resolvePageBrowsingLevel,
  resolveViewerBrowsingLevel,
} from '~/components/BrowsingLevel/resolve-browsing-level';
import {
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

type BrowsingModeProviderState = {
  forcedBrowsingLevel?: number;
  userBrowsingLevel: number;
  browsingLevelOverride?: number;
  childBrowsingLevelOverride?: number;
  blurLevels: number;
};

/**
 * Exported for `__tests__/browsing-level-hooks.test.ts`, which renders the two
 * hooks under a hand-built value. The precedence they encode is a safety rule —
 * the domain cap must beat both the page override and the viewer's preference —
 * and the ORDER of that precedence lives in how each hook MAPS this context
 * onto the resolver, which no test of the resolver alone can reach.
 *
 * ⚠️ What that test does NOT cover: the cap's VALUE, computed below from
 * `features.canViewNsfw` and `currentUser`. Supplying the context by hand is
 * what makes the hooks testable at all, and it is exactly what makes that
 * computation invisible to them.
 */
export const BrowsingModeOverrideCtx = createContext<
  BrowsingModeProviderState & {
    setBrowsingLevelOverride?: React.Dispatch<React.SetStateAction<number | undefined>>;
    setForcedBrowsingLevel?: React.Dispatch<React.SetStateAction<number | undefined>>;
  }
>({
  userBrowsingLevel: publicBrowsingLevelsFlag,
  blurLevels: nsfwBrowsingLevelsFlag,
});

export const useBrowsingLevelContext = () => useContext(BrowsingModeOverrideCtx);

export function BrowsingLevelProvider({
  children,
  browsingLevel: parentBrowsingLevelOverride,
  forcedBrowsingLevel: parentForcedBrowsingLevel,
}: {
  children: React.ReactNode;
  browsingLevel?: number;
  forcedBrowsingLevel?: number;
}) {
  const ctx = useBrowsingLevelContext();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const userBrowsingLevel = useBrowsingSettings((state) =>
    state.showNsfw ? state.browsingLevel : publicBrowsingLevelsFlag
  );
  const blurNsfw = useBrowsingSettings((x) => x.blurNsfw);
  const [childBrowsingLevelOverride, setBrowsingLevelOverride] = useState<number | undefined>();
  const [forcedBrowsingLevel, setForcedBrowsingLevel] = useState(parentForcedBrowsingLevel);

  // Cap rules mirror the server middleware (src/server/trpc.ts applyDomainFeature):
  //   anonymous (any domain)     → publicBrowsingLevelsFlag (PG)
  //   logged-in on green domain  → sfwBrowsingLevelsFlag    (PG + PG-13)
  //   logged-in on blue/red      → no forced cap, use saved preference
  // Verified bots aren't a special case here — on green they're treated as
  // any public user (PG only); on blue/red their session settings express
  // allBrowsingLevelsFlag and pass through unchecked.
  const domainForcedLevel = !features.canViewNsfw
    ? currentUser
      ? sfwBrowsingLevelsFlag
      : publicBrowsingLevelsFlag
    : undefined;

  return (
    <BrowsingModeOverrideCtx.Provider
      value={{
        forcedBrowsingLevel: forcedBrowsingLevel ?? domainForcedLevel ?? ctx.forcedBrowsingLevel,
        userBrowsingLevel: userBrowsingLevel,
        browsingLevelOverride:
          childBrowsingLevelOverride ?? parentBrowsingLevelOverride ?? ctx.browsingLevelOverride,
        childBrowsingLevelOverride: childBrowsingLevelOverride ?? ctx.childBrowsingLevelOverride,
        blurLevels: blurNsfw
          ? nsfwBrowsingLevelsFlag
          : Flags.diff(nsfwBrowsingLevelsFlag, userBrowsingLevel),
        setBrowsingLevelOverride,
        setForcedBrowsingLevel,
      }}
    >
      {children}
    </BrowsingModeOverrideCtx.Provider>
  );
}

export function useBrowsingLevelDebounced() {
  const { forcedBrowsingLevel, browsingLevelOverride, userBrowsingLevel } =
    useBrowsingLevelContext();
  const browsingLevel = resolvePageBrowsingLevel({
    forced: forcedBrowsingLevel,
    override: browsingLevelOverride,
    user: userBrowsingLevel,
  });
  const [debounced] = useDebouncedValue(browsingLevel, 500);
  return debounced ? debounced : BROWSING_LEVEL_FALLBACK;
}

/**
 * The viewer's own browsing level, ignoring any per-page override.
 *
 * `useBrowsingLevelDebounced` resolves `forcedBrowsingLevel ?? browsingLevelOverride
 * ?? userBrowsingLevel`. The middle term is what a page sets when it wants its
 * subtree read at some OTHER level — the image detail page passes the image's own
 * rating, so everything in its sidebar is scoped to that image rather than to the
 * person looking at it.
 *
 * That is right for the image and wrong for a list of OTHER people's images
 * beside it: an entry rated above the host can never intersect the host's own
 * level, so it is dropped for every viewer including the owner who approved it.
 * Measured on prod 2026-08-29: 161 of 488 approved remix-gallery entries were
 * invisible that way, 160 of them paid.
 *
 * 🔴 `forcedBrowsingLevel` is still honoured, and that is the whole reason this
 * is a separate hook rather than a call to `useBrowsingSettings`. It carries the
 * DOMAIN cap — anonymous anywhere is PG, logged-in on the green domain is
 * PG+PG-13 — which mirrors the server middleware and is not a preference anyone
 * may opt out of. Only the page-level override is skipped.
 */
export function useViewerBrowsingLevelDebounced() {
  const { forcedBrowsingLevel, userBrowsingLevel } = useBrowsingLevelContext();
  const browsingLevel = resolveViewerBrowsingLevel({
    forced: forcedBrowsingLevel,
    user: userBrowsingLevel,
  });
  const [debounced] = useDebouncedValue(browsingLevel, 500);
  return debounced ? debounced : BROWSING_LEVEL_FALLBACK;
}

export function BrowsingLevelProviderOptional({
  children,
  browsingLevel,
}: {
  children: React.ReactElement;
  browsingLevel?: number;
}) {
  return browsingLevel ? (
    <BrowsingLevelProvider browsingLevel={browsingLevel}>{children}</BrowsingLevelProvider>
  ) : (
    children
  );
}
