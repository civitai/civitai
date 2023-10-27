import { trpc } from '~/utils/trpc';

export const useHiddenPreferences = () => {
  const { data = { model: [], image: [], tag: [], user: [] }, isLoading } =
    trpc.hiddenPreferences.getHidden.useQuery();
  return { data, isLoading: isLoading };
};

export const useHiddenPreferencesData = () => {
  const { data } = useHiddenPreferences();
  return data;
};
