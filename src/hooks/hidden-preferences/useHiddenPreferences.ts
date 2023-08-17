import { trpc } from '~/utils/trpc';

export const useHiddenPreferences = () => {
  const { data = { model: [], image: [], tag: [], user: [] } } =
    trpc.hiddenPreferences.getHidden.useQuery();
  return data;
};
