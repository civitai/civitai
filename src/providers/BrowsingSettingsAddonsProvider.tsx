import { createContext, useContext, useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingSettingsAddon, DEFAULT_BROWSING_SETTINGS_ADDONS } from '~/server/common/constants';
import { Flags } from '~/shared/utils';
import { trpc } from '~/utils/trpc';

const BrowsingSettingsAddonsCtx = createContext<{
  isLoading: boolean;
  settings: Omit<BrowsingSettingsAddon, 'type' | 'nsfwLevels'>;
}>({
  settings: {
    disableMinor: false,
    disablePoi: false,
    excludedTagIds: [],
    excludedFooterLinks: [],
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
        try {
          let apply = false;
          if (elem.type === 'some') {
            apply = Flags.intersection(browsingLevel, Flags.arrayToInstance(elem.nsfwLevels)) !== 0;
          }

          if (elem.type === 'all') {
            apply =
              Flags.intersection(browsingLevel, Flags.arrayToInstance(elem.nsfwLevels)) ===
              Flags.arrayToInstance(elem.nsfwLevels);
          }

          if (elem.type === 'none') {
            apply = Flags.intersection(browsingLevel, Flags.arrayToInstance(elem.nsfwLevels)) === 0;
          }

          if (apply) {
            acc.disablePoi = elem.disablePoi || acc.disablePoi;
            acc.disableMinor = elem.disableMinor || acc.disableMinor;
            acc.excludedTagIds.push(...(elem.excludedTagIds ?? []));
            acc.excludedFooterLinks.push(...(elem.excludedFooterLinks ?? []));
          }

          return acc;
        } catch (error) {
          console.error('Error evaluating shouldApply function:', error);
          return acc;
        }
      },
      {
        disableMinor: false,
        disablePoi: false,
        excludedTagIds: [] as number[],
        excludedFooterLinks: [] as string[],
      }
    );
  }, [browsingLevel, data]);

  console.log({ browsingLevel, settings });

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
