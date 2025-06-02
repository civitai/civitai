import type { ReactNode } from 'react';
import { useContext, createContext, useMemo, useDeferredValue } from 'react';
import { useQueryHiddenPreferences } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import type { HiddenTag } from '~/server/services/user-preferences.service';

export type HiddenPreferencesState = {
  hiddenUsers: Map<number, boolean>;
  hiddenTags: Map<number, boolean>;
  hiddenModels: Map<number, boolean>;
  hiddenImages: Map<number, boolean>;
  hiddenLoading: boolean;
  moderatedTags: HiddenTag[];
  systemHiddenTags: Map<number, boolean>;
};

const HiddenPreferencesContext = createContext<HiddenPreferencesState | null>(null);
export const useHiddenPreferencesContext = () => {
  const context = useContext(HiddenPreferencesContext);
  if (!context)
    throw new Error('useHiddenPreferences can only be used inside HiddenPreferencesProvider');
  return context;
};

export const HiddenPreferencesProvider = ({ children }: { children: ReactNode }) => {
  const { data, isLoading } = useQueryHiddenPreferences();
  const currentUser = useCurrentUser();
  const disableHidden = useBrowsingSettings((x) => x.disableHidden);
  const { settings } = useBrowsingSettingsAddons();

  const hidden = useMemo(() => {
    const moderatedTags = data.hiddenTags.filter((x) => !!x.nsfwLevel);
    const tags = new Map(
      data.hiddenTags.filter((x) => !disableHidden && x.hidden).map((x) => [x.id, true])
    );

    const images = new Map(
      data.hiddenImages.filter((x) => !x.tagId || tags.get(x.tagId)).map((x) => [x.id, true])
    );

    const dedupedHiddenUsers = !currentUser?.isModerator
      ? [
          ...new Set(
            [...data.hiddenUsers, ...data.blockedUsers, ...data.blockedByUsers].map((x) => x.id)
          ),
        ]
      : data.hiddenUsers.map((x) => x.id);

    return {
      hiddenUsers: new Map(dedupedHiddenUsers.map((id) => [id, true])),
      hiddenModels: new Map(data.hiddenModels.map((x) => [x.id, true])),
      hiddenTags: tags,
      hiddenImages: images,
      hiddenLoading: isLoading,
      moderatedTags,
      systemHiddenTags: new Map((settings?.excludedTagIds ?? []).map((id) => [id, true])),
    };
  }, [data, isLoading, disableHidden, settings]);

  const hiddenDeferred = useDeferredValue(hidden);

  return (
    <HiddenPreferencesContext.Provider value={hiddenDeferred}>
      {children}
    </HiddenPreferencesContext.Provider>
  );
};
