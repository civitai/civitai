import { uniq } from 'lodash-es';
import { useMemo } from 'react';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import type { GetFeaturedModels } from '~/server/services/model.service';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { Availability } from '~/shared/utils/prisma/enums';
import { parseAIRSafe } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const take = 20;

export type Tabs = 'all' | 'featured' | 'recent' | 'liked' | 'mine';

export function useResourceSelectQueries(selectedTab: Tabs) {
  const currentUser = useCurrentUser();
  const { selectSource } = useResourceSelectContext();

  const { data: likedModels } = trpc.user.getBookmarkedModels.useQuery(undefined, {
    enabled: !!currentUser && selectedTab === 'liked',
  });

  const { data: featuredModels, isFetching: isLoadingFeatured } =
    trpc.model.getFeaturedModels.useQuery();

  const { data: generationData, isFetching: isLoadingGenerations } = useGetTextToImageRequests(
    { take },
    { enabled: !!currentUser && selectedTab === 'recent' && selectSource === 'generation' }
  );

  const { data: trainingModels, isFetching: isLoadingTraining } =
    trpc.model.getAvailableTrainingModels.useQuery(
      { take },
      { enabled: !!currentUser && selectedTab === 'recent' && selectSource === 'training' }
    );

  const { data: manuallyAdded, isFetching: isLoadingManuallyAdded } =
    trpc.model.getRecentlyManuallyAdded.useQuery(
      { take },
      { enabled: !!currentUser && selectedTab === 'recent' && selectSource === 'addResource' }
    );

  const { data: recommendedModels, isFetching: isLoadingRecommendedModels } =
    trpc.model.getRecentlyRecommended.useQuery(
      { take },
      { enabled: !!currentUser && selectedTab === 'recent' && selectSource === 'modelVersion' }
    );

  const { data: auctionModels, isFetching: isLoadingAuctionModels } =
    trpc.model.getRecentlyBid.useQuery(
      { take },
      { enabled: !!currentUser && selectedTab === 'recent' && selectSource === 'auction' }
    );

  const isLoadingExtra =
    (isLoadingFeatured && selectedTab === 'featured') ||
    ((isLoadingGenerations ||
      isLoadingTraining ||
      isLoadingManuallyAdded ||
      isLoadingRecommendedModels ||
      isLoadingAuctionModels) &&
      selectedTab === 'recent');

  return {
    likedModels,
    featuredModels,
    generationData,
    trainingModels,
    manuallyAdded,
    recommendedModels,
    auctionModels,
    isLoadingExtra,
  };
}

export function useResourceSelectMeiliFilters({
  selectedTab,
  featuredModels,
  generationData,
  trainingModels,
  manuallyAdded,
  recommendedModels,
  auctionModels,
  likedModels,
}: {
  selectedTab: Tabs;
  featuredModels: GetFeaturedModels | undefined;
  generationData: ReturnType<typeof useGetTextToImageRequests>['data'];
  trainingModels: any;
  manuallyAdded: any;
  recommendedModels: any;
  auctionModels: any;
  likedModels: number[] | undefined;
}) {
  const currentUser = useCurrentUser();
  const { canGenerate, resources, selectSource, filters } = useResourceSelectContext();

  return useMemo((): string | null => {
    // Don't compute filters until featured models are loaded on the featured tab
    if (selectedTab === 'featured' && !featuredModels) return null;

    const meiliFilters: string[] = [
      // Default filter for visibility:
      selectSource === 'auction' || !currentUser?.id
        ? `availability != ${Availability.Private}`
        : `(availability != ${Availability.Private} OR user.id = ${currentUser?.id})`,
    ];

    const or: string[] = [];

    if (canGenerate !== undefined) meiliFilters.push(`canGenerate = ${canGenerate}`);
    if (selectSource === 'auction') meiliFilters.push(`NOT cannotPromote = true`);

    // On the featured tab, determine which types have featured models so we can
    // skip the baseModel filter for those types in the OR clause, and instead use
    // an AND with featured IDs to explicitly return featured models
    const featuredByType = new Map<string, number[]>();
    if (selectedTab === 'featured' && featuredModels?.length) {
      for (const fm of featuredModels) {
        const ids = featuredByType.get(fm.type) ?? [];
        ids.push(fm.modelId);
        featuredByType.set(fm.type, ids);
      }
    }

    for (const { type, baseModels = [] } of resources) {
      const _type = filters.types.length > 0 ? filters.types.find((x) => x === type) : type;

      // On the featured tab, skip baseModel for all types —
      // the AND filter with featured IDs restricts results instead
      const _baseModels = featuredByType.size > 0
        ? []
        : filters.baseModels.length > 0
        ? filters.baseModels.filter((baseModel) => baseModels.includes(baseModel))
        : baseModels;

      if (_type) {
        if (!_baseModels.length) or.push(`type = ${_type}`);
        else
          or.push(
            `(type = ${_type} AND versions.baseModel IN [${_baseModels
              .map((x) => `"${x}"`)
              .join(',')}])`
          );
      }
    }

    // On the featured tab, add featured model IDs as an AND to restrict
    // results to auction winners for the matching resource types
    if (featuredByType.size > 0) {
      const resourceTypes = resources.map((r) => r.type);
      const featuredIds = [
        ...new Set(
          featuredModels!.filter((fm) => resourceTypes.includes(fm.type)).map((fm) => fm.modelId)
        ),
      ];
      if (featuredIds.length > 0) {
        meiliFilters.push(`id IN [${featuredIds.join(',')}]`);
      }
    }

    if (or.length) meiliFilters.push(`(${or.join(' OR ')})`);

    const exclude: string[] = ['NOT tags.name = "celebrity"'];

    if (filters.types.length) {
      meiliFilters.push(`type IN [${filters.types.map((x) => `"${x}"`).join(',')}]`);
    }
    if (filters.baseModels.length) {
      meiliFilters.push(
        `versions.baseModel IN [${filters.baseModels.map((x) => `"${x}"`).join(',')}]`
      );
    }

    if (selectedTab === 'featured') {
      // Featured model ID filtering is handled by the AND clause above
    } else if (selectedTab === 'recent') {
      if (selectSource === 'generation') {
        if (!!generationData) {
          const usedResources = uniq(
            generationData.flatMap((wf) =>
              wf.steps.flatMap((step) => step.resources?.map((r: any) => r.model.id))
            )
          );
          meiliFilters.push(`id IN [${usedResources.join(',')}]`);
        }
      } else if (selectSource === 'addResource') {
        if (!!manuallyAdded) {
          meiliFilters.push(`id IN [${manuallyAdded.join(',')}]`);
        }
      } else if (selectSource === 'training') {
        if (!!trainingModels) {
          const customModels = trainingModels.flatMap((m: any) =>
            m.modelVersions
              .map(
                (mv: any) =>
                  parseAIRSafe((mv.trainingDetails as TrainingDetailsObj | undefined)?.baseModel)
                    ?.model
              )
              .filter(isDefined)
          );
          meiliFilters.push(`id IN [${uniq(customModels).join(',')}]`);
        }
      } else if (selectSource === 'modelVersion') {
        if (!!recommendedModels) {
          meiliFilters.push(`id IN [${recommendedModels.join(',')}]`);
        }
      } else if (selectSource === 'auction') {
        if (!!auctionModels) {
          meiliFilters.push(`id IN [${auctionModels.join(',')}]`);
        }
      }
    } else if (selectedTab === 'liked') {
      if (!!likedModels) {
        meiliFilters.push(`id IN [${likedModels.join(',')}]`);
      }
    } else if (selectedTab === 'mine') {
      if (currentUser) {
        meiliFilters.push(`user.id = ${currentUser.id}`);
      }
    }

    return [...meiliFilters, ...exclude].join(' AND ');
  }, [
    canGenerate,
    resources,
    selectSource,
    filters,
    selectedTab,
    featuredModels,
    generationData,
    trainingModels,
    manuallyAdded,
    recommendedModels,
    auctionModels,
    likedModels,
    currentUser,
  ]);
}
