import { useContext, createContext, useRef, useEffect, ReactNode, useMemo } from 'react';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { hiddenPreferences, useUserPreferencesStore } from '~/store/hidden-preferences.store';

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

  const { explicit, hidden, moderated } = useUserPreferencesStore((state) => ({
    explicit: state.explicit,
    hidden: state.hidden,
    moderated: state.moderated,
  }));

  useEffect(() => {
    if (initRef) {
      hiddenPreferences.getPreferences().then(() => {
        initRef.current = false;
      });
    }
  }, []);

  const users = useMemo(() => new Map(explicit.users.map((id) => [id, true])), [explicit.users]);
  const images = useMemo(() => {
    const arr = [...explicit.images];
    // if(browsingMode === BrowsingMode.NSFW)
  }, [explicit.images, hidden.images, moderated.images, browsingMode]);

  return <HiddenPreferencesContext.Provider value={}>{children}</HiddenPreferencesContext.Provider>;
};
