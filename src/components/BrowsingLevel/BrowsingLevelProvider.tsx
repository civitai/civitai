import React, { createContext, useContext, useState } from 'react';
import {
  flagifyBrowsingLevel,
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { useDebouncedValue } from '@mantine/hooks';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { Flags } from '~/shared/utils';
import { useDomainSettings } from '~/providers/DomainSettingsProvider';

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
  const domainSettings = useDomainSettings();
  const userBrowsingLevel = useBrowsingSettings((state) =>
    state.showNsfw ? state.browsingLevel : publicBrowsingLevelsFlag
  );
  const allowedNsfwLevelsFlag = domainSettings?.allowedNsfwLevels
    ? flagifyBrowsingLevel(domainSettings?.allowedNsfwLevels)
    : 0;
  const intersection = Flags.intersection(userBrowsingLevel, allowedNsfwLevelsFlag);
  const adjustedUserBrowsingLevel = domainSettings?.allowedNsfwLevels
    ? domainSettings.disableNsfwLevelControl
      ? allowedNsfwLevelsFlag
      : intersection !== 0
      ? intersection
      : // Ensures we fallback to a proper value if the intersection is 0
        allowedNsfwLevelsFlag
    : userBrowsingLevel;
  const blurNsfw = useBrowsingSettings((x) => x.blurNsfw);
  const [childBrowsingLevelOverride, setBrowsingLevelOverride] = useState<number | undefined>();
  const [forcedBrowsingLevel, setForcedBrowsingLevel] = useState(parentForcedBrowsingLevel);

  return (
    <BrowsingModeOverrideCtx.Provider
      value={{
        forcedBrowsingLevel:
          domainSettings?.disableNsfwLevelControl && domainSettings.allowedNsfwLevels
            ? allowedNsfwLevelsFlag
            : forcedBrowsingLevel ?? parentForcedBrowsingLevel,
        userBrowsingLevel: adjustedUserBrowsingLevel,
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
