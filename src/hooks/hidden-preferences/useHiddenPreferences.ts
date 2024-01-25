import { useMemo } from 'react';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';
import { HiddenPreferenceBase } from '~/server/services/user-preferences.service';
import { useDidUpdate } from '@mantine/hooks';
import { create } from 'zustand';

export const useQueryHiddenPreferences = () => {
  const { data, isLoading } = trpc.hiddenPreferences.getHidden.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });
  const _data = useMemo(() => data ?? { model: [], image: [], tag: [], user: [] }, [data]);
  return { data: _data, isLoading: isLoading };
};

export const useHiddenPreferencesData = () => {
  const { data } = useQueryHiddenPreferences();
  return data;
};

type PreferencesState = {
  users: Map<number, boolean>;
  images: Map<number, boolean>;
  models: Map<number, boolean>;
  tags: Map<number, boolean>;
  isLoading: boolean;
};
const useStore = create<Partial<Record<BrowsingMode, PreferencesState>>>(() => ({}));

export function useHiddenPreferencesContext(browsingModeOverride?: BrowsingMode) {
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
