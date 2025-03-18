import React, { createContext, useContext, useState } from 'react';
import {
  greenBrowsingLevelsFlag,
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { useDebouncedValue } from '@mantine/hooks';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { Flags } from '~/shared/utils';

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
  const { canChangeBrowsingLevel, isGreen } = useFeatureFlags();
  const userBrowsingLevel = useBrowsingSettings((state) =>
    state.showNsfw ? state.browsingLevel : publicBrowsingLevelsFlag
  );
  const blurNsfw = useBrowsingSettings((x) => x.blurNsfw);
  const [childBrowsingLevelOverride, setBrowsingLevelOverride] = useState<number | undefined>();
  const [forcedBrowsingLevel, setForcedBrowsingLevel] = useState(parentForcedBrowsingLevel);

  return (
    <BrowsingModeOverrideCtx.Provider
      value={{
        forcedBrowsingLevel: canChangeBrowsingLevel
          ? forcedBrowsingLevel ?? parentForcedBrowsingLevel
          : isGreen
          ? greenBrowsingLevelsFlag
          : undefined,
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
  return debounced;
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
