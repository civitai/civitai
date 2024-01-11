import { trpc } from '~/utils/trpc';

export const useHiddenPreferences = () => {
  const { data = { model: [], image: [], tag: [], user: [] }, isLoading } =
    trpc.hiddenPreferences.getHidden.useQuery(undefined, {
      trpc: { context: { skipBatch: true } },
    });
  return { data, isLoading: isLoading };
};

export const useHiddenPreferencesData = () => {
  const { data } = useHiddenPreferences();
  return data;
};
