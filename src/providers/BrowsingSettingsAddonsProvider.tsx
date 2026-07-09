import { createContext, useContext, useMemo } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { BrowsingSettingsAddon } from '~/shared/constants/browsing-settings-addons';
import {
  DEFAULT_BROWSING_SETTINGS_ADDONS,
  resolveBrowsingSettingsAddons,
} from '~/shared/constants/browsing-settings-addons';
import { trpc } from '~/utils/trpc';

const BrowsingSettingsAddonsCtx = createContext<{
  isLoading: boolean;
  settings: NonNullable<Omit<BrowsingSettingsAddon, 'type' | 'nsfwLevels'>>;
}>({
  settings: {
    disableMinor: false,
    disablePoi: false,
    excludedTagIds: [],
    excludedFooterLinks: [],
    generationDefaultValues: {},
    generationMinValues: {},
  },
  isLoading: true,
});

export type useBrowsingSettingsAddonsReturn = ReturnType<typeof useBrowsingSettingsAddons>;
export const useBrowsingSettingsAddons = () => {
  const context = useContext(BrowsingSettingsAddonsCtx);
  return context;
};
export const BrowsingSettingsAddonsProvider = ({
  children,
  initialData,
}: {
  children: React.ReactNode;
  // SSR-seeded global addon list. Sharing the query key, only the outermost
  // provider needs it — nested mounts read the primed cache without refetching.
  initialData?: BrowsingSettingsAddon[];
}) => {
  const { data = DEFAULT_BROWSING_SETTINGS_ADDONS, isLoading } =
    trpc.system.getBrowsingSettingAddons.useQuery(undefined, {
      gcTime: Infinity,
      staleTime: Infinity,
      initialData,
    });
  const currentUser = useCurrentUser();
  const browsingLevel = useBrowsingLevelDebounced();

  const settings = useMemo(
    () =>
      resolveBrowsingSettingsAddons(data, browsingLevel, {
        isModerator: currentUser?.isModerator,
      }),
    [browsingLevel, data, currentUser?.isModerator]
  );

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
