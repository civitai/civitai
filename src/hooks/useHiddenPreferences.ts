import { useEffect, useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { BrowsingMode } from '~/server/common/enums';
import { trpc } from '~/utils/trpc';

type UseHiddenPreferencesProps = {
  tags?: boolean;
  users?: boolean;
  images?: boolean;
  models?: boolean;
};

export const useHiddenPreferences = ({
  tags,
  users,
  images,
  models,
}: UseHiddenPreferencesProps) => {
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const showAll = browsingMode === BrowsingMode.All;
  const currentUser = useCurrentUser();
  const enabled = !!currentUser;
  const options = {
    cacheTime: Infinity,
    staleTime: Infinity,
    trpc: { context: { skipBatch: false } },
    placeholderData: [],
    keepPreviousData: true,
  };
  const imageResults = trpc.user.getHiddenPreferences.useQuery(
    { type: 'images' },
    { enabled: images && enabled, ...options }
  );
  const imageIds = useMemo(
    () => (showAll || imageResults.isLoading || imageResults.error ? [] : imageResults.data),
    [imageResults.data, imageResults.error, imageResults.isLoading, showAll]
  );

  const modelResults = trpc.user.getHiddenPreferences.useQuery(
    { type: 'models' },
    { enabled: models && enabled, ...options }
  );
  const modelIds = useMemo(
    () => (showAll || modelResults.isLoading || modelResults.error ? [] : modelResults.data),
    [modelResults.data, modelResults.error, modelResults.isLoading, showAll]
  );

  const userResults = trpc.user.getHiddenPreferences.useQuery(
    { type: 'users' },
    { enabled: users && enabled, ...options }
  );
  const userIds = useMemo(
    () => (showAll || userResults.isLoading || userResults.error ? [] : userResults.data),
    [userResults.data, userResults.error, userResults.isLoading, showAll]
  );

  const tagResults = trpc.user.getHiddenPreferences.useQuery(
    { type: 'tags' },
    { enabled: tags && enabled, ...options }
  );
  const tagIds = useMemo(
    () => (showAll || tagResults.isLoading || tagResults.error ? [] : tagResults.data),
    [tagResults.data, tagResults.error, tagResults.isLoading, showAll]
  );

  return {
    imageIds,
    modelIds,
    userIds,
    tagIds,
  };
};
