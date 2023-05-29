import { useMemo } from 'react';
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

/*
  - Safe
    - system tags
    - my tags
  - My Filters
    - my tags
  - Everything
    - no tags
*/
export const useHiddenPreferences = ({
  tags,
  users,
  images,
  models,
}: UseHiddenPreferencesProps) => {
  const currentUser = useCurrentUser();
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const hideNsfw =
    !currentUser?.showNsfw || (currentUser.showNsfw && browsingMode === BrowsingMode.SFW);
  const showAll = !!currentUser && browsingMode === BrowsingMode.All;
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
  // need system tags when browsing in SFW mode or when there is no session user
  const systemTagResults = trpc.user.getSystemHiddenTags.useQuery(undefined, {
    enabled: tags && hideNsfw,
    ...options,
  });
  const tagIds = useMemo(() => {
    const userHiddenTags =
      showAll || tagResults.isLoading || tagResults.error ? [] : tagResults.data;

    const systemHiddenTags =
      showAll || systemTagResults.isLoading || systemTagResults.error
        ? { moderated: [], hidden: [] }
        : systemTagResults.data;

    return [
      ...new Set([
        ...userHiddenTags,
        ...(hideNsfw
          ? [...(systemHiddenTags.moderated ?? []), ...(systemHiddenTags.hidden ?? [])]
          : []),
      ]),
    ];
  }, [
    tagResults.data,
    tagResults.error,
    tagResults.isLoading,
    showAll,
    hideNsfw,
    systemTagResults.isLoading,
    systemTagResults.error,
    systemTagResults.data,
  ]);

  // const isLoading = (images && imageResults.isLoading) || (models && modelResults.)

  return {
    imageIds,
    modelIds,
    userIds,
    tagIds,
  };
};
