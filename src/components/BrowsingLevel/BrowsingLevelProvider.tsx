import React, { createContext, useContext, useDeferredValue, useState } from 'react';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { useDebouncedValue } from '@mantine/hooks';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';

const BrowsingModeOverrideCtx = createContext<{
  browsingLevelOverride?: number;
  setBrowsingLevelOverride?: React.Dispatch<React.SetStateAction<number | undefined>>;
}>({});
export const useBrowsingModeOverrideContext = () => useContext(BrowsingModeOverrideCtx);
export function BrowsingModeOverrideProvider({
  children,
  browsingLevel,
}: {
  children: React.ReactNode;
  browsingLevel?: number;
}) {
  const { canViewNsfw } = useFeatureFlags();
  const [browsingLevelOverride, setBrowsingLevelOverride] = useState<number | undefined>();

  return (
    <BrowsingModeOverrideCtx.Provider
      value={{
        browsingLevelOverride: canViewNsfw
          ? browsingLevelOverride ?? browsingLevel
          : publicBrowsingLevelsFlag,
        setBrowsingLevelOverride,
      }}
    >
      {children}
    </BrowsingModeOverrideCtx.Provider>
  );
}

function useBrowsingLevel() {
  const { browsingLevelOverride } = useBrowsingModeOverrideContext();
  const browsingLevel = useBrowsingSettings((x) => x.browsingLevel);
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  if (browsingLevelOverride) return browsingLevelOverride;
  if (!showNsfw) return publicBrowsingLevelsFlag;
  return browsingLevel;
}

export function useBrowsingLevelDebounced() {
  const browsingLevel = useBrowsingLevel();
  const [debounced] = useDebouncedValue(browsingLevel, 500);
  return useDeferredValue(debounced ?? browsingLevel);
}
