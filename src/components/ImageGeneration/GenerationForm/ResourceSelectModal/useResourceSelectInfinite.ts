import { keepPreviousData } from '@tanstack/react-query';
import { uniq } from 'lodash-es';
import { useMemo } from 'react';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const limit = 50;

export function useResourceSelectInfinite({ query }: { query: string }) {
  const currentUser = useCurrentUser();
  const { tab, sort, selectSource, resources, filters, canGenerate, excludedIds, categoryTag } =
    useResourceSelectContext();

  // recent → generation is the one curated source the server can't resolve on its
  // own (orchestrator history). Fetch it here and pass the model ids down.
  const isGenerationRecent = tab === 'recent' && selectSource === 'generation';
  const { data: generationData } = useGetTextToImageRequests(
    { take: limit },
    { enabled: !!currentUser && isGenerationRecent }
  );

  const restrictToIds = useMemo(() => {
    if (!isGenerationRecent) return undefined;
    if (!generationData) return undefined;
    return uniq(
      generationData.flatMap((wf) =>
        wf.steps.flatMap((step) => step.resources?.map((r) => r.model.id) ?? [])
      )
    ).filter(isDefined);
  }, [isGenerationRecent, generationData]);

  // Hold the query until the generation-history ids are ready, so we don't fire an
  // unrestricted first request that then flips to the restricted set.
  const enabled = !isGenerationRecent || restrictToIds !== undefined;

  const queryResult = trpc.model.getResourceSelect.useInfiniteQuery(
    {
      tab,
      selectSource,
      query: query || undefined,
      sort,
      limit,
      resources: resources.map((r) => ({ type: r.type as ModelType, baseModels: r.baseModels })),
      filterTypes: filters.types,
      filterBaseModels: filters.baseModels,
      tagName: categoryTag,
      canGenerate,
      excludedVersionIds: excludedIds,
      restrictToIds,
    },
    {
      enabled,
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      placeholderData: keepPreviousData,
    }
  );

  const items = useMemo(
    () => queryResult.data?.pages.flatMap((p) => p.items) ?? [],
    [queryResult.data]
  );

  return { ...queryResult, items };
}
