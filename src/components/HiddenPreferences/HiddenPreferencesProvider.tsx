import type { ReactNode } from 'react';
import { useContext, createContext, useMemo, useDeferredValue } from 'react';
import { useQueryHiddenPreferences } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import type { HiddenTag } from '~/server/services/user-preferences.service';

export type HiddenPreferencesState = {
  hiddenUsers: Map<number, boolean>;
  /** Blocks in either direction; also merged into `hiddenUsers`. Empty for moderators. */
  blockRelations: Map<number, boolean>;
  hiddenTags: Map<number, boolean>;
  hiddenModels: Map<number, boolean>;
  hiddenModel3Ds: Map<number, boolean>;
  hiddenImages: Map<number, boolean>;
  hiddenLoading: boolean;
  moderatedTags: HiddenTag[];
  systemHiddenTags: Map<number, boolean>;
};

type UserRef = { id: number };

export function deriveHiddenUsers(
  data: { hiddenUsers: UserRef[]; blockedUsers: UserRef[]; blockedByUsers: UserRef[] },
  isModerator: boolean
) {
  const blocked = isModerator ? [] : [...data.blockedUsers, ...data.blockedByUsers];
  const toMap = (users: UserRef[]) => new Map(users.map((x): [number, boolean] => [x.id, true]));
  return {
    hiddenUsers: toMap([...data.hiddenUsers, ...blocked]),
    blockRelations: toMap(blocked),
  };
}

type HiddenPreferencesData = ReturnType<typeof useQueryHiddenPreferences>['data'];

/**
 * The provider's state from the expanded `hiddenPreferences.getHidden` data, outside React — also
 * read by the bot lean model page (`~/server/bot-cache/lean/models-lean`), so both filter alike.
 */
export function hiddenPreferencesState(
  data: HiddenPreferencesData,
  {
    isModerator,
    disableHidden,
    excludedTagIds,
    isLoading,
  }: {
    isModerator: boolean;
    disableHidden: boolean;
    excludedTagIds: number[] | undefined;
    isLoading: boolean;
  }
): HiddenPreferencesState {
  const moderatedTags = data.hiddenTags.filter((x) => !!x.nsfwLevel);
  const tags = new Map(
    data.hiddenTags.filter((x) => !disableHidden && x.hidden).map((x) => [x.id, true])
  );

  const images = new Map(
    data.hiddenImages.filter((x) => !x.tagId || tags.get(x.tagId)).map((x) => [x.id, true])
  );

  const { hiddenUsers, blockRelations } = deriveHiddenUsers(data, isModerator);

  return {
    hiddenUsers,
    blockRelations,
    hiddenModels: new Map(data.hiddenModels.map((x) => [x.id, true])),
    hiddenModel3Ds: new Map(data.hiddenModel3Ds.map((x) => [x.id, true])),
    hiddenTags: tags,
    hiddenImages: images,
    hiddenLoading: isLoading,
    moderatedTags,
    systemHiddenTags: new Map((excludedTagIds ?? []).map((id) => [id, true])),
  };
}

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

  const hidden = useMemo(
    () =>
      hiddenPreferencesState(data, {
        isModerator: !!currentUser?.isModerator,
        disableHidden: !!disableHidden,
        excludedTagIds: settings?.excludedTagIds,
        isLoading,
      }),
    [data, isLoading, disableHidden, settings]
  );

  const hiddenDeferred = useDeferredValue(hidden);

  return (
    <HiddenPreferencesContext.Provider value={hiddenDeferred}>
      {children}
    </HiddenPreferencesContext.Provider>
  );
};
