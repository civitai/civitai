import { useMemo } from 'react';
import { trpc } from '~/utils/trpc';

export const useQueryHiddenPreferences = () => {
  const { data, isLoading } = trpc.hiddenPreferences.getHidden.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });
  const _data = useMemo(
    () => data ?? { hiddenModels: [], hiddenImages: [], hiddenTags: [], hiddenUsers: [] },
    [data]
  );
  return { data: _data, isLoading: isLoading };
};

export const useHiddenPreferencesData = () => {
  const { data } = useQueryHiddenPreferences();
  return data;
};
