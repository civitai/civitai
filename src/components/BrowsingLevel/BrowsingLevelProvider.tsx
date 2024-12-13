import React, { createContext, useContext, useMemo, useState } from 'react';
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
import { useRouter } from 'next/router';

const BrowsingModeOverrideCtx = createContext<{
  browsingLevel: number;
  blurLevels: number;
  setBrowsingLevelOverride?: React.Dispatch<React.SetStateAction<number | undefined>>;
}>({ browsingLevel: publicBrowsingLevelsFlag, blurLevels: nsfwBrowsingLevelsFlag });
export const useBrowsingLevelContext = () => useContext(BrowsingModeOverrideCtx);
export function BrowsingLevelProvider({
  children,
  browsingLevel: parentBrowsingLevelOverride,
}: {
  children: React.ReactNode;
  browsingLevel?: number;
}) {
  const router = useRouter();
  const { canViewNsfw } = useFeatureFlags();
  const currentBrowsingLevel = useBrowsingSettings((state) => state.browsingLevel);
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  const blurNsfw = useBrowsingSettings((x) => x.blurNsfw);
  const [childBrowsingLevelOverride, setBrowsingLevelOverride] = useState<number | undefined>();

  const [browsingLevelDebounced] = useDebouncedValue(currentBrowsingLevel, 500);
  const browsingLevelOverride = useMemo(() => {
    if (!canViewNsfw) return publicBrowsingLevelsFlag;
    const override = childBrowsingLevelOverride ?? parentBrowsingLevelOverride;
    if (override) {
      const max = Math.max(...Flags.instanceToArray(override));
      return Flags.arrayToInstance(browsingLevels.filter((level) => level <= max));
    }
    if (!showNsfw) return publicBrowsingLevelsFlag;
  }, [parentBrowsingLevelOverride, childBrowsingLevelOverride, showNsfw, canViewNsfw]);

  const browsingLevel = browsingLevelOverride ?? browsingLevelDebounced ?? currentBrowsingLevel;

  const blurLevels = useMemo(
    () =>
      blurNsfw
        ? nsfwBrowsingLevelsFlag
        : router.asPath.includes('moderator')
        ? 0 // allow mods to view all levels unblurred
        : Flags.arrayToInstance(
            nsfwBrowsingLevelsArray.filter((level) => !Flags.hasFlag(currentBrowsingLevel, level))
          ),
    [browsingLevel, blurNsfw]
  );

  return (
    <BrowsingModeOverrideCtx.Provider
      value={{
        blurLevels,
        browsingLevel: currentBrowsingLevel < browsingLevel ? currentBrowsingLevel : browsingLevel,
        setBrowsingLevelOverride,
      }}
    >
      {children}
    </BrowsingModeOverrideCtx.Provider>
  );
}

export function useBrowsingLevelDebounced() {
  const { browsingLevel: browsingLevelOverride } = useBrowsingLevelContext();
  return browsingLevelOverride;
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
