import React, { createContext, useContext, useDeferredValue, useMemo, useState } from 'react';
import {
  browsingLevels,
  nsfwBrowsingLevelsArray,
  nsfwBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { useDebouncedValue } from '@mantine/hooks';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { Flags } from '~/shared/utils';

const BrowsingModeOverrideCtx = createContext<{
  browsingLevelOverride: number;
  blurLevels: number;
  setBrowsingLevelOverride?: React.Dispatch<React.SetStateAction<number | undefined>>;
}>({ browsingLevelOverride: publicBrowsingLevelsFlag, blurLevels: nsfwBrowsingLevelsFlag });
export const useBrowsingModeOverrideContext = () => useContext(BrowsingModeOverrideCtx);
export function BrowsingModeOverrideProvider({
  children,
  browsingLevel: parentBrowsingLevelOverride,
}: {
  children: React.ReactNode;
  browsingLevel?: number;
}) {
  const { canViewNsfw } = useFeatureFlags();
  const currentBrowsingLevel = useBrowsingSettings((state) => state.browsingLevel);
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  const blurNsfw = useBrowsingSettings((x) => x.blurNsfw);
  const [childBrowsingLevelOverride, setBrowsingLevelOverride] = useState<number | undefined>();

  const browsingLevel = useMemo(() => {
    if (!canViewNsfw) return publicBrowsingLevelsFlag;
    const override = childBrowsingLevelOverride ?? parentBrowsingLevelOverride;
    if (override) {
      const max = Math.max(...Flags.instanceToArray(override));
      return Flags.arrayToInstance(browsingLevels.filter((level) => level <= max));
    }
    if (!showNsfw) return publicBrowsingLevelsFlag;
    return currentBrowsingLevel;
  }, [
    parentBrowsingLevelOverride,
    childBrowsingLevelOverride,
    currentBrowsingLevel,
    showNsfw,
    canViewNsfw,
  ]);

  const [debouncedBrowsingLevel] = useDebouncedValue(browsingLevel, 1000);
  const deferredDebouncedBrowsingLevel = useDeferredValue(debouncedBrowsingLevel);
  const blurLevels = useMemo(
    () =>
      blurNsfw
        ? nsfwBrowsingLevelsFlag
        : Flags.arrayToInstance(
            nsfwBrowsingLevelsArray.filter((level) => !Flags.hasFlag(currentBrowsingLevel, level))
          ),
    [deferredDebouncedBrowsingLevel, blurNsfw]
  );

  return (
    <BrowsingModeOverrideCtx.Provider
      value={{
        blurLevels,
        browsingLevelOverride: deferredDebouncedBrowsingLevel,
        setBrowsingLevelOverride,
      }}
    >
      {children}
    </BrowsingModeOverrideCtx.Provider>
  );
}

export function useBrowsingLevelDebounced() {
  const { browsingLevelOverride } = useBrowsingModeOverrideContext();
  return browsingLevelOverride;
}
