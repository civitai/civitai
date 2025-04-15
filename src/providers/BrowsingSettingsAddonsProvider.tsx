import { createContext, useContext, useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingSettingsAddon, DEFAULT_BROWSING_SETTINGS_ADDONS } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';

const BrowsingSettingsAddonsCtx = createContext<{
  isLoading: boolean;
  settings: Omit<BrowsingSettingsAddon, 'shouldApply'>;
}>({
  settings: {
    disablePoi: false,
    excludedTagIds: [],
  },
  isLoading: true,
});

export type useBrowsingSettingsAddonsReturn = ReturnType<typeof useBrowsingSettingsAddons>;
export const useBrowsingSettingsAddons = () => {
  const context = useContext(BrowsingSettingsAddonsCtx);
  return context;
};
export const BrowsingSettingsAddonsProvider = ({ children }: { children: React.ReactNode }) => {
  const { data = DEFAULT_BROWSING_SETTINGS_ADDONS, isLoading } =
    trpc.system.getBrowsingSettingAddons.useQuery(undefined, {
      cacheTime: Infinity,
      staleTime: Infinity,
    });

  const browsingLevel = useBrowsingLevelDebounced();

  const settings = useMemo(() => {
    return data.reduce(
      (acc, elem) => {
        if (elem.shouldApply(browsingLevel)) {
          acc.disablePoi = elem.disablePoi || acc.disablePoi;
          acc.excludedTagIds.push(...elem.excludedTagIds);
        }

        return acc;
      },
      {
        disablePoi: false,
        excludedTagIds: [] as number[],
      }
    );
  }, [browsingLevel, data, isLoading]);

  return (
    <BrowsingSettingsAddonsCtx.Provider
      value={{
        isLoading,
        settings,
      }}
    >
      {children}
    </BrowsingSettingsAddonsCtx.Provider>
  );
};
