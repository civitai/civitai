import { useDebouncedValue } from '@mantine/hooks';
import React, { createContext, useContext, useState } from 'react';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NsfwLevel } from '~/server/common/enums';
import {
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';

type BrowsingModeProviderState = {
  forcedBrowsingLevel?: number;
  userBrowsingLevel: number;
  browsingLevelOverride?: number;
  childBrowsingLevelOverride?: number;
  blurLevels: number;
};

const BrowsingModeOverrideCtx = createContext<
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
  const { canViewNsfw } = useFeatureFlags();
  const userBrowsingLevel = useBrowsingSettings((state) =>
    state.showNsfw ? state.browsingLevel : publicBrowsingLevelsFlag
  );
  const blurNsfw = useBrowsingSettings((x) => x.blurNsfw);
  const [childBrowsingLevelOverride, setBrowsingLevelOverride] = useState<number | undefined>();
  const [forcedBrowsingLevel, setForcedBrowsingLevel] = useState(parentForcedBrowsingLevel);

  return (
    <BrowsingModeOverrideCtx.Provider
      value={{
        forcedBrowsingLevel: !canViewNsfw
          ? publicBrowsingLevelsFlag
          : forcedBrowsingLevel ?? ctx.forcedBrowsingLevel,
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
  const browsingLevel = forcedBrowsingLevel ?? browsingLevelOverride ?? userBrowsingLevel;
  const [debounced] = useDebouncedValue(browsingLevel, 500);
  return debounced ? debounced : NsfwLevel.PG;
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
