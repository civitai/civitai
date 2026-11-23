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
  /** Creators who blocked the viewer, a subset of `blockRelations`. Empty for moderators. */
  blockedByUsers?: Map<number, boolean>;
  hiddenTags: Map<number, boolean>;
  hiddenModels: Map<number, boolean>;
  hiddenModel3Ds: Map<number, boolean>;
  hiddenImages: Map<number, boolean>;
  /** The `hiddenImages` hidden by the viewer's vote on a moderated tag they hide. */
  moderatedHiddenImages: Map<number, boolean>;
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
    blockedByUsers: toMap(isModerator ? [] : data.blockedByUsers),
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

  const hidden = useMemo(() => {
    const moderatedTags = data.hiddenTags.filter((x) => !!x.nsfwLevel);
    const tags = new Map(
      data.hiddenTags.filter((x) => !disableHidden && x.hidden).map((x) => [x.id, true])
    );

    const images = new Map(
      data.hiddenImages.filter((x) => !x.tagId || tags.get(x.tagId)).map((x) => [x.id, true])
    );
    const moderatedIds = new Set(moderatedTags.map((x) => x.id));
    const moderatedHiddenImages = new Map(
      data.hiddenImages
        .filter((x) => x.tagId && tags.get(x.tagId) && moderatedIds.has(x.tagId))
        .map((x): [number, boolean] => [x.id, true])
    );

    const { hiddenUsers, blockRelations, blockedByUsers } = deriveHiddenUsers(
      data,
      !!currentUser?.isModerator
    );

    return {
      hiddenUsers,
      blockRelations,
      blockedByUsers,
      hiddenModels: new Map(data.hiddenModels.map((x) => [x.id, true])),
      hiddenModel3Ds: new Map(data.hiddenModel3Ds.map((x) => [x.id, true])),
      hiddenTags: tags,
      hiddenImages: images,
      moderatedHiddenImages,
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
