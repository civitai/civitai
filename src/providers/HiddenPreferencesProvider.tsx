import { useContext, createContext, useRef, useEffect, ReactNode, useMemo } from 'react';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { hiddenPreferences, useHiddenPreferencesStore } from '~/store/hidden-preferences.store';

type HiddenPreferencesState = {
  users: Map<number, boolean>;
  tags: Map<number, boolean>;
  models: Map<number, boolean>;
  images: Map<number, boolean>;
};

const HiddenPreferencesContext = createContext<HiddenPreferencesState | null>(null);
export const useHiddenPreferences = () => {
  const context = useContext(HiddenPreferencesContext);
  if (!context)
    throw new Error('useHiddenPreferences can only be used inside HiddenPreferencesProvider');
  return context;
};

export const HiddenPreferencesProvider = ({ children }: { children: ReactNode }) => {
  const initRef = useRef(true);
  const browsingMode = useFiltersContext((state) => state.browsingMode);

  const { explicit, hidden, moderated } = useHiddenPreferencesStore((state) => ({
    explicit: state.explicit,
    hidden: state.hidden,
    moderated: state.moderated,
  }));

  useEffect(() => {
    if (initRef.current) {
      initRef.current = false;
      hiddenPreferences.getPreferences();
    }
  }, []);

  const users = useMemo(() => new Map(explicit.users.map((id) => [id, true])), [explicit.users]);
  const images = useMemo(
    () =>
      getMapped({
        explicit: explicit.images,
        hidden: hidden.images,
        moderated: moderated.images,
        browsingMode,
      }),
    [explicit.images, hidden.images, moderated.images, browsingMode]
  );
  const models = useMemo(
    () =>
      getMapped({
        explicit: explicit.models,
        hidden: hidden.models,
        moderated: moderated.models,
        browsingMode,
      }),
    [explicit.models, hidden.models, moderated.models, browsingMode]
  );
  const tags = useMemo(
    () => getMapped({ hidden: hidden.tags, moderated: moderated.tags, browsingMode }),
    [hidden.tags, moderated.tags, browsingMode]
  );

  return (
    <HiddenPreferencesContext.Provider value={{ users, images, models, tags }}>
      {children}
    </HiddenPreferencesContext.Provider>
  );
};

const getMapped = ({
  explicit = [],
  hidden,
  moderated,
  browsingMode,
}: {
  explicit?: number[];
  hidden: number[];
  moderated: number[];
  browsingMode: BrowsingMode;
}) => {
  let arr = [...explicit];
  if (browsingMode !== BrowsingMode.All) {
    arr = [...arr, ...hidden];
    if (browsingMode !== BrowsingMode.NSFW) {
      arr = [...arr, ...moderated];
    }
  }
  return new Map(arr.map((id) => [id, true]));
};
