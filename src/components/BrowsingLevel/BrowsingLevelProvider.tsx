import React, { createContext, useContext, useDeferredValue, useMemo, useState } from 'react';
import {
  BrowsingLevel,
  browsingModeDefaults,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils';
import { setCookie } from '~/utils/cookies-helpers';
import { trpc } from '~/utils/trpc';
import { createDebouncer } from '~/utils/debouncer';
import { useDebouncedValue, useDidUpdate } from '@mantine/hooks';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useCivitaiSessionContext } from '~/components/CivitaiWrapped/CivitaiSessionProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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
  const [browsingLevelOverride, setBrowsingLevelOverride] = useState(
    canViewNsfw ? browsingLevel : publicBrowsingLevelsFlag
  );

  useDidUpdate(
    () => setBrowsingLevelOverride(canViewNsfw ? browsingLevel : publicBrowsingLevelsFlag),
    [browsingLevel]
  );

  return (
    <BrowsingModeOverrideCtx.Provider value={{ browsingLevelOverride, setBrowsingLevelOverride }}>
      {children}
    </BrowsingModeOverrideCtx.Provider>
  );
}

export function useBrowsingLevelDebounced() {
  const browsingLevel = useBrowsingSettings((x) => x.browsingLevel);
  const [debounced] = useDebouncedValue(browsingLevel, 500);
  return useDeferredValue(debounced ?? browsingLevel);
}
