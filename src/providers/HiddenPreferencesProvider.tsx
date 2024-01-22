import { useDidUpdate } from '@mantine/hooks';
import { useContext, createContext, ReactNode, useMemo, useDeferredValue, useEffect } from 'react';
import { create } from 'zustand';
import { useQueryHiddenPreferences } from '~/hooks/hidden-preferences';
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

export const HiddenPreferencesProvider = ({
  children,
  browsingMode,
}: {
  children: ReactNode;
  browsingMode?: BrowsingMode;
}) => {
  const value = useHiddenPreferences(browsingMode);

  return (
    <HiddenPreferencesContext.Provider value={value}>{children}</HiddenPreferencesContext.Provider>
  );
};

type StoreState = Record<BrowsingMode, HiddenPreferencesState>;
const useStore = create<Partial<StoreState>>(() => ({}));

function useHiddenPreferences(browsingModeOverride?: BrowsingMode) {
  const browsingMode = useFiltersContext((state) => browsingModeOverride ?? state.browsingMode);
  const { data, isLoading } = useQueryHiddenPreferences();

  function mapPreferences() {
    return {
      users: new Map(data.user.map((user) => [user.id, true])),
      images: getMapped({ data: data.image, browsingMode }),
      models: getMapped({ data: data.model, browsingMode }),
      tags: getMapped({ data: data.tag, browsingMode }),
      isLoading,
    };
  }

  useDidUpdate(() => {
    useStore.setState({ [browsingMode]: mapPreferences() });
  }, [data]);

  useDidUpdate(() => {
    if (!useStore.getState()[browsingMode]) {
      useStore.setState({ [browsingMode]: mapPreferences() });
    }
  }, [browsingMode]);

  const storedPreferences = useStore((state) => state[browsingMode]);

  if (!storedPreferences) {
    const preferences = mapPreferences();
    useStore.setState({ [browsingMode]: preferences });
    return preferences;
  }

  return storedPreferences;
}

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
