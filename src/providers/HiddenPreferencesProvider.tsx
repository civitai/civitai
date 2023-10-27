import { useContext, createContext, ReactNode, useMemo, useDeferredValue } from 'react';
import { useHiddenPreferences } from '~/hooks/hidden-preferences';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { HiddenPreferenceBase } from '~/server/services/user-preferences.service';

type HiddenPreferencesState = {
  users: Map<number, boolean>;
  tags: Map<number, boolean>;
  models: Map<number, boolean>;
  images: Map<number, boolean>;
  isLoading: boolean;
};

const HiddenPreferencesContext = createContext<HiddenPreferencesState | null>(null);
export const useHiddenPreferencesContext = () => {
  const context = useContext(HiddenPreferencesContext);
  if (!context)
    throw new Error('useHiddenPreferences can only be used inside HiddenPreferencesProvider');
  return context;
};

export const HiddenPreferencesProvider = ({ children }: { children: ReactNode }) => {
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, isLoading } = useHiddenPreferences();

  const users = useMemo(() => new Map(data.user.map((user) => [user.id, true])), [data.user]);
  const images = useMemo(
    () => getMapped({ data: data.image, browsingMode }),
    [data.image, browsingMode]
  );
  const models = useMemo(
    () => getMapped({ data: data.model, browsingMode }),
    [data.model, browsingMode]
  );
  const tags = useMemo(() => getMapped({ data: data.tag, browsingMode }), [data.tag, browsingMode]);

  return (
    <HiddenPreferencesContext.Provider
      value={{
        users: users,
        images: images,
        models: models,
        tags: tags,
        isLoading,
      }}
    >
      {children}
    </HiddenPreferencesContext.Provider>
  );
};

const getMapped = ({
  data,
  browsingMode,
}: {
  data: HiddenPreferenceBase[];
  browsingMode: BrowsingMode;
}) => {
  const arr = data.filter((x) => x.type === 'always');
  if (browsingMode !== BrowsingMode.All) {
    arr.push(...data.filter((x) => x.type === 'hidden'));
    if (browsingMode !== BrowsingMode.NSFW) {
      arr.push(...data.filter((x) => x.type === 'moderated'));
    }
  }
  return new Map(arr.map((x) => [x.id, true]));
};
