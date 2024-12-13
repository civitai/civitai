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
        : !router.asPath.startsWith('/moderator')
        ? Flags.arrayToInstance(
            nsfwBrowsingLevelsArray.filter((level) => !Flags.hasFlag(currentBrowsingLevel, level))
          )
        : 0, // TODO - allow mods to view all levels unblurred
    [browsingLevel, blurNsfw]
  );

  return (
    <BrowsingModeOverrideCtx.Provider
      value={{
        blurLevels,
        browsingLevelOverride: browsingLevel,
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
