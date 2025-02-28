import {
  ActionIcon,
  Badge,
  Button,
  Center,
  CloseButton,
  Divider,
  Group,
  Loader,
  Menu,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import {
  IconBrush,
  IconCloudOff,
  IconDotsVertical,
  IconDownload,
  IconHorse,
  IconInfoCircle,
  IconLock,
  IconSettings,
  IconTagOff,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { uniq } from 'lodash-es';
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Configure,
  InstantSearch,
  InstantSearchProps,
  useInstantSearch,
  useRefinementList,
} from 'react-instantsearch';
import { BidModelButton } from '~/components/Auction/AuctionUtils';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import {
  DescriptionTable,
  Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';
import { openReportModal } from '~/components/Dialog/dialog-registry';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { GenerationSettingsPopover } from '~/components/Generation/GenerationSettings';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import {
  ResourceSelectFiltersDropdown,
  ResourceSelectSort,
} from '~/components/ImageGeneration/GenerationForm/ResourceSelectFilters';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { ModelHash } from '~/components/Model/ModelHash/ModelHash';
import { ModelURN, URNExplanation } from '~/components/Model/ModelURN/ModelURN';
import { ModelVersionReview } from '~/components/Model/ModelVersions/ModelVersionReview';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { PermissionIndicator } from '~/components/PermissionIndicator/PermissionIndicator';
import { useToggleFavoriteMutation } from '~/components/ResourceReview/resourceReview.utils';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import { searchIndexMap } from '~/components/Search/search.types';
import { SearchIndexDataMap, useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { ThumbsUpIcon } from '~/components/ThumbsIcon/ThumbsIcon';
import { TrainedWords } from '~/components/TrainedWords/TrainedWords';
import { TwCard } from '~/components/TwCard/TwCard';
import { useCurrentUserSettings } from '~/components/UserSettings/hooks';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BaseModel, constants } from '~/server/common/constants';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { ReportEntity } from '~/server/schema/report.schema';
import type { GenerationResource } from '~/server/services/generation/generation.service';
import type { GetFeaturedModels } from '~/server/services/model.service';
import { getIsSdxl } from '~/shared/constants/generation.constants';
import { Availability } from '~/shared/utils/prisma/enums';
import { fetchGenerationData } from '~/store/generation.store';
import { aDayAgo, formatDate } from '~/utils/date-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { getDisplayName, parseAIRSafe } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import {
  ResourceFilter,
  ResourceSelectOptions,
  ResourceSelectSource,
} from './resource-select.types';

// type SelectValue =
//   | ({ kind: 'generation' } & GenerationResource)
//   | { kind: 'training' | 'addResource' | 'modelVersion' };
type GenerationResourceWithImage = GenerationResource & {
  image: SearchIndexDataMap['models'][number]['images'][number];
};
export type ResourceSelectModalProps = {
  title?: React.ReactNode;
  onSelect: (value: GenerationResourceWithImage) => void;
  onClose?: () => void;
  options?: ResourceSelectOptions;
  selectSource?: ResourceSelectSource;
};

const tabs = ['featured', 'all', 'recent', 'liked', 'mine'] as const;
type Tabs = (typeof tabs)[number];

const take = 20;

// TODO - ResourceSelectProvider with filter so that we only show relevant model versions to select

type ResourceSelectState = Omit<ResourceSelectModalProps, 'options'> & {
  canGenerate?: boolean;
  excludedIds: number[];
  resources: DeepRequired<ResourceSelectOptions>['resources'];
  filters: ResourceFilter;
  setFilters: React.Dispatch<React.SetStateAction<ResourceFilter>>;
};

const ResourceSelectContext = createContext<ResourceSelectState | null>(null);
export const useResourceSelectContext = () => {
  const context = useContext(ResourceSelectContext);
  if (!context) throw new Error('missing ResourceSelectContext');
  return context;
};

function ResourceSelectProvider({
  children,
  ...props
}: ResourceSelectModalProps & { children: React.ReactNode }) {
  const dialog = useDialogContext();
  const { generation } = useCurrentUserSettings();
  const [filters, setFilters] = useState<ResourceFilter>({
    types: [],
    baseModels: [],
  });
  const resources = (props.options?.resources ?? []).map(
    ({ type, baseModels = [], partialSupport = [] }) => ({
      type,
      baseModels: generation?.advancedMode ? [...baseModels, ...partialSupport] : baseModels,
      partialSupport,
    })
  );
  const resourceTypes = resources.map((x) => x.type);
  const types =
    resources.length > 0
      ? filters.types.filter((type) => resourceTypes.includes(type))
      : filters.types;

  const resourceBaseModels = [...new Set(resources.flatMap((x) => x.baseModels))];
  const baseModels =
    resourceBaseModels.length > 0
      ? filters.baseModels.filter((baseModel) => resourceBaseModels.includes(baseModel))
      : filters.baseModels;

  function handleSelect(value: GenerationResourceWithImage) {
    props.onSelect(value);
    dialog.onClose();
  }

  return (
    <ResourceSelectContext.Provider
      value={{
        ...props,
        selectSource: props.selectSource ?? 'generation',
        canGenerate: props.options?.canGenerate,
        excludedIds: props.options?.excludeIds ?? [],
        resources,
        filters: {
          types,
          baseModels,
        },
        setFilters,
        onSelect: handleSelect,
      }}
    >
      {children}
    </ResourceSelectContext.Provider>
  );
}

export default function ResourceSelectModal(props: ResourceSelectModalProps) {
  return (
    <ResourceSelectProvider {...props}>
      <ResourceSelectModalContent />
    </ResourceSelectProvider>
  );
}

function ResourceSelectModalContent() {
  const { title, onClose, canGenerate, resources, selectSource, filters } =
    useResourceSelectContext();
  const dialog = useDialogContext();
  const isMobile = useIsMobile();
  const currentUser = useCurrentUser();
  const [selectedTab, setSelectedTab] = useState<Tabs>('featured');
  // const availableBaseModels = [...new Set(resources.flatMap((x) => x.baseModels))];
  // const _selectedFilters = selectedFilters.filter((x) => availableBaseModels.includes)

  const {
    data: likedModels,
    // isLoading: isLoadingLikedModels,
    // isError: isErrorLikedModels,
  } = trpc.user.getBookmarkedModels.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const {
    data: featuredModels,
    isFetching: isLoadingFeatured,
    // isError: isErrorFeatured,
  } = trpc.model.getFeaturedModels.useQuery();

  const {
    steps,
    isFetching: isLoadingGenerations,
    // isError: isErrorGenerations,
  } = useGetTextToImageRequests(
    { take },
    { enabled: !!currentUser && selectedTab === 'recent' && selectSource === 'generation' }
  );

  const {
    data: trainingModels,
    isFetching: isLoadingTraining,
    // isError: isErrorTraining,
  } = trpc.model.getAvailableTrainingModels.useQuery(
    { take },
    { enabled: !!currentUser && selectedTab === 'recent' && selectSource === 'training' }
  );

  const {
    data: manuallyAdded,
    isFetching: isLoadingManuallyAdded,
    // isError: isErrorManuallyAdded,
  } = trpc.model.getRecentlyManuallyAdded.useQuery(
    { take },
    { enabled: !!currentUser && selectedTab === 'recent' && selectSource === 'addResource' }
  );

  const {
    data: recommendedModels,
    isFetching: isLoadingRecommendedModels,
    // isError: isErrorRecommendedModels,
  } = trpc.model.getRecentlyRecommended.useQuery(
    { take },
    { enabled: !!currentUser && selectedTab === 'recent' && selectSource === 'modelVersion' }
  );

  const {
    data: auctionModels,
    isFetching: isLoadingAuctionModels,
    // isError: isErrorAuctionModels,
  } = trpc.model.getRecentlyBid.useQuery(
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

  // TODO handle fetching errors from above

  const allowedTabs = tabs.filter((t) => {
    return !(!currentUser && ['recent', 'liked', 'mine'].includes(t));
  });

  const meiliFilters: string[] = [
    // Default filter for visibility:
    `(availability != ${Availability.Private} OR user.id = ${currentUser?.id})`,
  ];

  const or: string[] = [];
  if (canGenerate !== undefined) meiliFilters.push(`canGenerate = ${canGenerate}`);
  for (const { type, baseModels = [] } of resources) {
    const _type = filters.types.length > 0 ? filters.types.find((x) => x === type) : type;
    const _baseModels =
      filters.baseModels.length > 0
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
  if (or.length) meiliFilters.push(`(${or.join(' OR ')})`);

  const exclude: string[] = [];
  exclude.push('NOT tags.name = "celebrity"');

  // nb - it would be nice to do this, but meili filters the entire top level object only
  // if (excludeIds.length > 0) {
  //   exclude.push(`versions.id NOT IN [${excludeIds.join(',')}]`);
  // }

  if (filters.types.length) {
    meiliFilters.push(`type IN [${filters.types.map((x) => `"${x}"`).join(',')}]`);
  }
  if (filters.baseModels.length) {
    meiliFilters.push(
      `versions.baseModel IN [${filters.baseModels.map((x) => `"${x}"`).join(',')}]`
    );
  }

  if (selectedTab === 'featured') {
    if (!!featuredModels) {
      meiliFilters.push(`id IN [${featuredModels.map((fm) => fm.modelId).join(',')}]`);
    }
  } else if (selectedTab === 'recent') {
    if (selectSource === 'generation') {
      if (!!steps) {
        const usedResources = uniq(
          steps.flatMap(({ resources }) => resources.map((r) => r.model.id))
        );
        meiliFilters.push(`id IN [${usedResources.join(',')}]`);
      }
    } else if (selectSource === 'addResource') {
      if (!!manuallyAdded) {
        meiliFilters.push(`id IN [${manuallyAdded.join(',')}]`);
      }
    } else if (selectSource === 'training') {
      if (!!trainingModels) {
        const customModels = trainingModels.flatMap((m) =>
          m.modelVersions
            .map(
              (mv) =>
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

  const totalFilters = [...meiliFilters, ...exclude].join(' AND ');

  function handleClose() {
    dialog.onClose();
    onClose?.();
  }

  return (
    <Modal {...dialog} onClose={handleClose} size={1200} withCloseButton={false} padding={0}>
      <div className="flex size-full max-h-full max-w-full flex-col">
        <InstantSearch
          searchClient={searchClient}
          indexName={searchIndexMap.models}
          future={{ preserveSharedStateOnUnmount: true }}
        >
          <Configure hitsPerPage={20} filters={totalFilters} />

          <div className="sticky top-[-48px] z-30 flex flex-col gap-3 bg-gray-0 p-3 dark:bg-dark-7">
            <div className="flex flex-wrap items-center justify-between gap-4 sm:gap-10">
              <Text>{title}</Text>
              <CustomSearchBox
                isMobile={isMobile}
                autoFocus
                className="order-last w-full grow sm:order-none sm:w-auto"
              />
              <CloseButton onClick={handleClose} />
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:flex-nowrap sm:items-center sm:justify-between sm:gap-10">
              <SegmentedControl
                value={selectedTab}
                onChange={(v) => setSelectedTab(v as Tabs)}
                data={allowedTabs.map((v) => ({ value: v, label: v.toUpperCase() }))}
                className="shrink-0 @sm:w-full"
              />
              <CategoryTagFilters />
              <div className="flex shrink-0 flex-row items-center justify-end gap-3">
                <ResourceSelectSort />
                <ResourceSelectFiltersDropdown />
                <GenerationSettingsPopover>
                  <ActionIcon>
                    <IconSettings />
                  </ActionIcon>
                </GenerationSettingsPopover>
              </div>
            </div>

            <Divider />
          </div>

          {isLoadingExtra ? (
            <div className="p-3 py-5">
              <Center mt="md">
                <Loader />
              </Center>
            </div>
          ) : (
            <ResourceHitList
              likes={likedModels}
              featured={featuredModels}
              selectedTab={selectedTab}
            />
          )}
        </InstantSearch>
      </div>
    </Modal>
  );
}

function CategoryTagFilters() {
  const [tag, setTag] = useState<string>();
  const { refine } = useRefinementList({ attribute: 'tags.name' });

  const handleSetTag = (value?: string) => {
    if (tag) refine(tag);
    if (value) refine(value);
    setTag(value);
  };

  return (
    <CategoryTags
      selected={tag}
      setSelected={handleSetTag}
      filter={(tag) => !['celebrity'].includes(tag)}
      includeEA={false}
      includeAll={false}
    />
  );
}

function ResourceHitList({
  likes,
  featured,
  selectedTab,
}: ResourceSelectOptions & {
  likes: number[] | undefined;
  featured: GetFeaturedModels | undefined;
  selectedTab: Tabs;
}) {
  const { canGenerate, resources, selectSource, excludedIds } = useResourceSelectContext();
  const startedRef = useRef(false);
  // const currentUser = useCurrentUser();
  const { status } = useInstantSearch();
  const { classes } = useSearchLayoutStyles();
  const { items, showMore, isLastPage } = useInfiniteHitsTransformed<'models'>();
  const {
    items: models,
    loadingPreferences,
    hiddenCount,
  } = useApplyHiddenPreferences({
    type: 'models',
    data: items,
  });

  const loading =
    status === 'loading' || status === 'stalled' || loadingPreferences || !startedRef.current;

  const filtered = useMemo(() => {
    if (!canGenerate && !resources.length) return models;

    return models
      .map((model) => {
        const resourceType = resources.find((x) => x.type === model.type);
        if (!resourceType) return null;
        const { baseModels } = resourceType;

        const versions = model.versions.filter((version) => {
          return (
            (canGenerate ? canGenerate === version.canGenerate : true) &&
            (baseModels.length > 0 ? baseModels.includes(version.baseModel) : true) &&
            !excludedIds.includes(version.id)
          );
        });
        if (!versions.length) return null;
        return { ...model, versions };
      })
      .filter(isDefined)
      .filter((model) => model.versions.length > 0);
  }, [canGenerate, excludedIds, models, resources]);

  useEffect(() => {
    if (!startedRef.current && status !== 'idle') startedRef.current = true;
  }, [status]);

  // TODO should these checks be off "filtered" or "items"?
  if (loading && !items.length)
    return (
      <div className="p-3 py-5">
        <Center mt="md">
          <Loader />
        </Center>
      </div>
    );

  if (!filtered.length)
    return (
      <div className="p-3 py-5">
        <Center>
          <Stack spacing="md" align="center" maw={800}>
            {hiddenCount > 0 && (
              <Text color="dimmed">
                {hiddenCount} models have been hidden due to your settings.
              </Text>
            )}
            <ThemeIcon size={128} radius={100} sx={{ opacity: 0.5 }}>
              <IconCloudOff size={80} />
            </ThemeIcon>
            <Title order={1} inline>
              No models found
            </Title>
            <Text align="center">
              We have a bunch of models, but it looks like we couldn&rsquo;t find any matching your
              query.
            </Text>
          </Stack>
        </Center>
      </div>
    );

  const filteredSorted =
    selectedTab === 'featured'
      ? filtered.sort((a, b) => {
          if (!featured) return 0;
          const aIndex = featured.findIndex((fm) => fm.modelId === a.id);
          const bIndex = featured.findIndex((fm) => fm.modelId === b.id);
          if (aIndex === -1) return 1;
          if (bIndex === -1) return -1;
          return aIndex - bIndex;
        })
      : filtered;
  const topItems = selectedTab === 'featured' ? filteredSorted.slice(0, 3) : [];
  const restItems = selectedTab === 'featured' ? filteredSorted.slice(3) : filteredSorted;

  return (
    // <ScrollArea id="resource-select-modal" className="flex-1 p-3">
    <div className="flex flex-col gap-3 p-3">
      {hiddenCount > 0 && (
        <Text color="dimmed">{hiddenCount} models have been hidden due to your settings.</Text>
      )}

      {topItems.length > 0 && (
        <Group align="center" position="center">
          <ResourceSelectCard
            data={topItems[0]}
            isFavorite={!!likes && likes.includes(topItems[0].id)}
            selectSource={selectSource}
            position={1}
          />
          {topItems.length > 1 && (
            <ResourceSelectCard
              data={topItems[1]}
              isFavorite={!!likes && likes.includes(topItems[1].id)}
              selectSource={selectSource}
              position={2}
            />
          )}
          {topItems.length > 2 && (
            <ResourceSelectCard
              data={topItems[2]}
              isFavorite={!!likes && likes.includes(topItems[2].id)}
              selectSource={selectSource}
              position={3}
            />
          )}
        </Group>
      )}
      <div className={classes.grid}>
        {restItems.map((model) => (
          <ResourceSelectCard
            key={model.id}
            data={model}
            isFavorite={!!likes && likes.includes(model.id)}
            selectSource={selectSource}
          />
        ))}
      </div>
      {items.length > 0 && !isLastPage && (
        <InViewLoader loadFn={showMore} loadCondition={status === 'idle'}>
          <Center sx={{ height: 36 }} my="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </div>
    // </ScrollArea>
  );
}

const IMAGE_CARD_WIDTH = 450;

const TopRightIcons = ({
  setFlipped,
  data,
  imageId,
}: {
  setFlipped: React.Dispatch<React.SetStateAction<boolean>>;
  data: SearchIndexDataMap['models'][number];
  imageId?: number;
}) => {
  const currentUser = useCurrentUser();

  let contextMenuItems: React.ReactNode[] = [];

  if (currentUser?.id !== data.user.id) {
    contextMenuItems = contextMenuItems
      .concat([
        <HideModelButton key="hide-model" as="menu-item" modelId={data.id} />,
        <HideUserButton key="hide-button" as="menu-item" userId={data.user.id} />,
        <ReportMenuItem
          key="report-model"
          loginReason="report-model"
          onReport={() => openReportModal({ entityType: ReportEntity.Model, entityId: data.id })}
        />,
        !!imageId ? (
          <ReportMenuItem
            key="report-image"
            label="Report image"
            onReport={() =>
              openReportModal({
                entityType: ReportEntity.Image,
                // Explicitly cast to number because we know it's not undefined
                entityId: imageId,
              })
            }
          />
        ) : undefined,
      ])
      .filter(isDefined);
  }
  if (currentUser)
    contextMenuItems.splice(
      2,
      0,
      <Menu.Item
        key="block-tags"
        icon={<IconTagOff size={14} stroke={1.5} />}
        onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
          e.preventDefault();
          e.stopPropagation();
          openContext('blockModelTags', { modelId: data.id });
        }}
      >
        {`Hide content with these tags`}
      </Menu.Item>
    );

  if (currentUser?.isModerator && env.NEXT_PUBLIC_MODEL_LOOKUP_URL) {
    contextMenuItems.unshift(
      <Menu.Item
        component="a"
        key="lookup-model"
        target="_blank"
        icon={<IconInfoCircle size={14} stroke={1.5} />}
        href={`${env.NEXT_PUBLIC_MODEL_LOOKUP_URL}${data.id}`}
        onClick={(e: React.MouseEvent<HTMLAnchorElement>) => {
          e.preventDefault();
          e.stopPropagation();
          window.open(`${env.NEXT_PUBLIC_MODEL_LOOKUP_URL}${data.id}`, '_blank');
        }}
      >
        Lookup Model
      </Menu.Item>
    );
  }

  return (
    <>
      <div className="absolute right-9 top-2 flex flex-col gap-1">
        <ActionIcon
          variant="transparent"
          className="mix-blend-difference"
          size="md"
          onClick={() => setFlipped((f) => !f)}
        >
          <IconInfoCircle strokeWidth={2.5} size={24} />
        </ActionIcon>
      </div>
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        {contextMenuItems.length > 0 && (
          <Menu position="left-start" withArrow offset={-5}>
            <Menu.Target>
              <ActionIcon
                variant="transparent"
                className="mix-blend-difference"
                p={0}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <IconDotsVertical size={24} style={{ filter: `drop-shadow(0 0 2px #000)` }} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>{contextMenuItems.map((el) => el)}</Menu.Dropdown>
          </Menu>
        )}
        <CivitaiLinkManageButton
          modelId={data.id}
          modelName={data.name}
          modelType={data.type}
          hashes={data.hashes}
          noTooltip
          iconSize={16}
        >
          {({ color, onClick, icon, label }) => (
            <HoverActionButton
              onClick={onClick}
              label={label}
              size={30}
              color={color}
              variant="filled"
              keepIconOnHover
            >
              {icon}
            </HoverActionButton>
          )}
        </CivitaiLinkManageButton>
      </div>
    </>
  );
};

function ResourceSelectCard({
  data,
  isFavorite,
  selectSource,
  position,
}: {
  data: SearchIndexDataMap['models'][number];
  isFavorite: boolean;
  selectSource?: ResourceSelectSource;
  position?: number;
}) {
  // const [ref, inView] = useInViewDynamic({ id: data.id.toString() });
  const { onSelect } = useResourceSelectContext();
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const [loading, setLoading] = useState(false);

  const image = data.images[0];
  const { classes, cx, theme } = useCardStyles({
    aspectRatio: image && image.width && image.height ? image.width / image.height : 1,
  });

  const versions = data.versions;
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const _selectedIndex = selectedIndex < versions.length ? selectedIndex : 0;
  const selectedVersion = versions[_selectedIndex];
  const [flipped, setFlipped] = useState(false);

  const handleSelect = async () => {
    const version = selectedVersion;
    if (!version) return;
    const { id } = version;

    setLoading(true);
    await fetchGenerationData({
      type: 'modelVersion',
      id,
      generation: selectSource !== 'generation' ? false : undefined,
    }).then((data) => {
      const resource = data.resources[0];
      if (selectSource !== 'generation') {
        onSelect({ ...resource, image });
      } else {
        if (resource?.canGenerate || resource.substitute?.canGenerate)
          onSelect({ ...resource, image });
        else
          showErrorNotification({
            error: new Error('This model is no longer available for generation'),
          });
      }
    });
    setLoading(false);
  };

  const favoriteMutation = useToggleFavoriteMutation();
  const handleToggleFavorite = ({ versionId, setTo }: { versionId?: number; setTo: boolean }) => {
    if (favoriteMutation.isLoading) return;
    favoriteMutation.mutate({
      modelId: data.id,
      modelVersionId: versionId,
      setTo,
    });
  };

  const isSDXL = getIsSdxl(selectedVersion.baseModel);
  const isPony = selectedVersion.baseModel === 'Pony';
  const isNew = data.publishedAt && data.publishedAt > aDayAgo;
  const isUpdated =
    data.lastVersionAt &&
    data.publishedAt &&
    data.lastVersionAt > aDayAgo &&
    data.lastVersionAt.getTime() - data.publishedAt.getTime() > constants.timeCutOffs.updatedModel;

  const originalAspectRatio = image.width && image.height ? image.width / image.height : 1;
  const width = originalAspectRatio > 1 ? IMAGE_CARD_WIDTH * originalAspectRatio : IMAGE_CARD_WIDTH;

  const modelDetails: DescriptionTableProps['items'] = [
    {
      label: 'Type',
      value: (
        <Badge radius="sm" px={5}>
          {getDisplayName(data.type)} {data.checkpointType}
        </Badge>
      ),
    },
    {
      label: 'Stats',
      value: (
        <Group spacing={4}>
          <IconBadge radius="xs" icon={<IconDownload size={14} />}>
            <Text>{(selectedVersion.metrics?.downloadCount ?? 0).toLocaleString()}</Text>
          </IconBadge>
          {selectedVersion.canGenerate && (
            <IconBadge radius="xs" icon={<IconBrush size={14} />}>
              <Text>{(selectedVersion.metrics?.generationCount ?? 0).toLocaleString()}</Text>
            </IconBadge>
          )}
        </Group>
      ),
    },
    {
      label: 'Reviews',
      value: (
        <ModelVersionReview
          modelId={data.id}
          versionId={selectedVersion.id}
          thumbsUpCount={selectedVersion.metrics?.thumbsUpCount ?? 0}
          thumbsDownCount={selectedVersion.metrics?.thumbsDownCount ?? 0}
        />
      ),
    },
    { label: 'Created', value: formatDate(selectedVersion.createdAt) },
    {
      label: 'Base Model',
      value:
        selectedVersion.baseModel === 'ODOR' ? (
          <Text component={Link} href="/product/odor" target="_blank">
            {selectedVersion.baseModel}{' '}
          </Text>
        ) : (
          <Text>
            {selectedVersion.baseModel}{' '}
            {selectedVersion.baseModelType && selectedVersion.baseModelType === 'Standard'
              ? ''
              : selectedVersion.baseModelType}
          </Text>
        ),
    },
    {
      label: 'Training',
      value: (
        <Group spacing={4}>
          {selectedVersion.steps && (
            <Badge size="sm" radius="sm" color="teal">
              Steps: {selectedVersion.steps.toLocaleString()}
            </Badge>
          )}
          {selectedVersion.epochs && (
            <Badge size="sm" radius="sm" color="teal">
              Epochs: {selectedVersion.epochs.toLocaleString()}
            </Badge>
          )}
        </Group>
      ),
      visible: !!selectedVersion.steps || !!selectedVersion.epochs,
    },
    {
      label: 'Usage Tips',
      value: (
        <Group spacing={4}>
          {selectedVersion.clipSkip && (
            <Badge size="sm" radius="sm" color="cyan">
              Clip Skip: {selectedVersion.clipSkip.toLocaleString()}
            </Badge>
          )}
          {!!selectedVersion.settings?.strength && (
            <Badge size="sm" radius="sm" color="cyan">
              {`Strength: ${selectedVersion.settings.strength}`}
            </Badge>
          )}
        </Group>
      ),
      visible: isDefined(selectedVersion.clipSkip) || isDefined(selectedVersion.settings?.strength),
    },
    {
      label: 'Trigger Words',
      visible: !!selectedVersion.trainedWords?.length,
      value: <TrainedWords trainedWords={selectedVersion.trainedWords} type={data.type} />,
    },
    {
      label: 'Hash',
      value: <ModelHash hashes={selectedVersion.hashData ?? []} width={80} />,
      visible: !!(selectedVersion.hashData ?? []).length,
    },
    {
      label: (
        <Group spacing="xs">
          <Text weight={500}>AIR</Text>
          <URNExplanation size={20} />
        </Group>
      ),
      value: (
        <ModelURN
          baseModel={selectedVersion.baseModel as BaseModel}
          type={data.type}
          modelId={data.id}
          modelVersionId={selectedVersion.id}
          withCopy={false}
        />
      ),
      visible: features.air,
    },
    {
      label: 'Restrictions',
      value: <PermissionIndicator permissions={data.permissions} showNone={true} />,
      visible: !!data.permissions,
    },
  ];

  // return (
  //   <AspectRatioImageCard
  //     href={`/models/${data.id}?modelVersionId=${selected}`}
  //     target="_blank"
  //     contentType="model"
  //     contentId={data.model.id}
  //     image={image}
  //     header={}
  //     footer={}
  //   />
  // );

  return (
    // Visually hide card if there are no versions
    <TwCard
      className={clsx(classes.root, 'justify-between', {
        '!shadow-[0_0_10px]': !!position && position < 3,
        '!shadow-yellow-5': position === 1,
        '!shadow-gray-5': position === 2,
        '!shadow-orange-5': position === 3,
      })}
      // onClick={handleSelect}
      style={{ display: versions.length === 0 ? 'none' : undefined }}
    >
      {/* {inView && ( */}
      <>
        {image &&
          (!flipped ? (
            <ImageGuard2 image={image} connectType="model" connectId={data.id}>
              {(safe) => {
                return (
                  <div className="relative overflow-hidden aspect-portrait">
                    {safe ? (
                      <Link
                        href={`/models/${data.id}?modelVersionId=${selectedVersion.id}`}
                        target="_blank"
                      >
                        <EdgeMedia
                          src={image.url}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
                          type={image.type}
                          width={width}
                          placeholder="empty"
                          className={classes.image}
                          loading="lazy"
                        />
                      </Link>
                    ) : (
                      <MediaHash {...image} />
                    )}
                    <div className="absolute left-2 top-2 flex items-center gap-1">
                      <ImageGuard2.BlurToggle />
                      <Badge
                        className={cx(classes.infoChip, classes.chip)}
                        variant="light"
                        radius="xl"
                      >
                        <Text color="white" size="xs" transform="capitalize">
                          {getDisplayName(data.type)}
                        </Text>
                        {isSDXL && (
                          <>
                            <Divider orientation="vertical" />
                            {isPony ? (
                              <IconHorse size={16} strokeWidth={2.5} />
                            ) : (
                              <Text color="white" size="xs">
                                XL
                              </Text>
                            )}
                          </>
                        )}
                      </Badge>

                      {(isNew || isUpdated) && (
                        <Badge
                          className={classes.chip}
                          variant="filled"
                          radius="xl"
                          sx={(theme) => ({
                            backgroundColor: isUpdated
                              ? '#1EBD8E'
                              : theme.colors.blue[theme.fn.primaryShade()],
                          })}
                        >
                          <Text color="white" size="xs" transform="capitalize">
                            {isUpdated ? 'Updated' : 'New'}
                          </Text>
                        </Badge>
                      )}
                    </div>
                    <TopRightIcons data={data} setFlipped={setFlipped} imageId={image.id} />
                    <Group className="absolute bottom-2 right-2 flex items-center gap-1">
                      {data.availability === Availability.Private && (
                        <Tooltip
                          label="This is a private model which requires permission to generate with."
                          position="top"
                          withArrow
                          withinPortal
                          multiline
                          maw={250}
                        >
                          <Badge
                            color="gray"
                            variant="filled"
                            h={30}
                            w={30}
                            className="flex items-center justify-center"
                            p={0}
                          >
                            <IconLock size={16} />
                          </Badge>
                        </Tooltip>
                      )}
                      {selectSource !== 'auction' && (
                        <BidModelButton
                          size="md"
                          variant={theme.colorScheme === 'light' ? undefined : 'light'}
                          px={4}
                          entityData={{
                            ...selectedVersion,
                            model: data,
                            image,
                          }}
                        />
                      )}
                      {!!currentUser && (
                        <Tooltip
                          label={isFavorite ? 'Unlike' : 'Like'}
                          position="top"
                          withArrow
                          withinPortal
                        >
                          <Button
                            onClick={() => handleToggleFavorite({ setTo: !isFavorite })}
                            color={isFavorite ? 'green' : 'gray'}
                            px={4}
                            size="xs"
                            variant={theme.colorScheme === 'light' ? undefined : 'light'}
                          >
                            <ThumbsUpIcon color="#fff" filled={isFavorite} size={20} />
                          </Button>
                        </Tooltip>
                      )}
                    </Group>
                  </div>
                );
              }}
            </ImageGuard2>
          ) : (
            <div className="relative overflow-auto aspect-portrait">
              <Stack className="size-full">
                <DescriptionTable
                  title="Model Details"
                  items={modelDetails}
                  labelWidth="80px"
                  withBorder
                  fontSize="xs"
                />
              </Stack>
              <TopRightIcons data={data} setFlipped={setFlipped} />
            </div>
          ))}

        <div className="flex flex-col gap-2 p-3 text-black dark:text-white">
          <Text size="sm" weight={700} lineClamp={1} lh={1}>
            {data.name}
          </Text>
          <Group noWrap position="apart">
            <Select
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              readOnly={versions.length <= 1}
              value={_selectedIndex?.toString()}
              data={versions.map((version, index) => ({
                label: version.name,
                value: index.toString(),
              }))}
              onChange={(index) => setSelectedIndex(Number(index ?? 0))}
              styles={{ input: { cursor: versions.length <= 1 ? 'auto !important' : undefined } }}
            />
            <Button
              loading={loading}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleSelect();
              }}
            >
              Select
            </Button>
          </Group>
        </div>
      </>
      {/* )} */}
    </TwCard>
  );
}

const meilisearch = instantMeiliSearch(
  env.NEXT_PUBLIC_SEARCH_HOST as string,
  env.NEXT_PUBLIC_SEARCH_CLIENT_KEY,
  { primaryKey: 'id', keepZeroFacets: true }
);

const searchClient: InstantSearchProps['searchClient'] = {
  ...meilisearch,
  search(requests) {
    return meilisearch.search(requests);
  },
};
