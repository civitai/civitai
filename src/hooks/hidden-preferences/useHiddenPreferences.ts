import { useMemo } from 'react';
import { trpc } from '~/utils/trpc';

export const useQueryHiddenPreferences = () => {
  const { data, ...rest } = trpc.hiddenPreferences.getHidden.useQuery(undefined, {
    trpc: { context: { skipBatch: true } },
  });
  const _data = useMemo(
    () =>
      data ?? {
        hiddenModels: [],
        hiddenImages: [],
        hiddenTags: [],
        hiddenUsers: [],
        blockedUsers: [],
        blockedByUsers: [],
      },
    [data]
  );
  return { data: _data, ...rest };
};

export const useHiddenPreferencesData = () => {
  const { data } = useQueryHiddenPreferences();
  return data;
};
