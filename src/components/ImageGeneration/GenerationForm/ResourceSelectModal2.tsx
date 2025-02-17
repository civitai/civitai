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
  IconTagOff,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { uniq } from 'lodash-es';
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Configure,
  InstantSearch,
  InstantSearchProps,
  useInstantSearch,
  useRefinementList,
} from 'react-instantsearch';
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
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BaseModel, constants } from '~/server/common/constants';
import { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { ReportEntity } from '~/server/schema/report.schema';
import { getIsSdxl } from '~/shared/constants/generation.constants';
import { aDayAgo, formatDate } from '~/utils/date-helpers';
import { getDisplayName, parseAIRSafe } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import {
  ResourceFilter,
  ResourceSelectOptions,
  ResourceSelectSource,
} from './resource-select.types';
import { GenerationResource } from '~/server/services/generation/generation.service';
import { fetchGenerationData } from '~/store/generation.store';
import { showErrorNotification } from '~/utils/notifications';

export type ResourceSelectModalProps = {
  title?: React.ReactNode;
  onSelect: (value: GenerationResource) => void;
  onClose?: () => void;
  options?: ResourceSelectOptions;
  selectSource?: ResourceSelectSource;
};

const tabs = ['all', 'featured', 'recent', 'liked', 'uploaded'] as const;
type Tabs = (typeof tabs)[number];

const take = 20;

export default function ResourceSelectModal({
  title,
  onSelect,
  onClose,
  options = {},
  selectSource = 'generation',
}: ResourceSelectModalProps) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile();
  const currentUser = useCurrentUser();
  const [selectedTab, setSelectedTab] = useState<Tabs>('all');
  const [selectFilters, setSelectFilters] = useState<ResourceFilter>({ types: [], baseModels: [] });

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

  const isLoadingExtra =
    (isLoadingFeatured && selectedTab === 'featured') ||
    ((isLoadingGenerations ||
      isLoadingTraining ||
      isLoadingManuallyAdded ||
      isLoadingRecommendedModels) &&
      selectedTab === 'recent');

  // TODO handle fetching errors from above

  const { resources = [], excludeIds = [], canGenerate } = options;
  const allowedTabs = tabs.filter((t) => {
    return !(!currentUser && ['recent', 'liked', 'uploaded'].includes(t));
  });

  const filters: string[] = [];
  const or: string[] = [];
  if (canGenerate !== undefined) filters.push(`canGenerate = ${canGenerate}`);
  for (const { type, baseModels } of resources) {
    if (!baseModels?.length) or.push(`type = ${type}`);
    else
      or.push(
        `(type = ${type} AND versions.baseModel IN [${baseModels.map((x) => `"${x}"`).join(',')}])`
      );
  }
  if (or.length) filters.push(`(${or.join(' OR ')})`);

  const exclude: string[] = [];
  exclude.push('NOT tags.name = "celebrity"');

  // nb - it would be nice to do this, but meili filters the entire top level object only
  // if (excludeIds.length > 0) {
  //   exclude.push(`versions.id NOT IN [${excludeIds.join(',')}]`);
  // }

  if (selectFilters.types.length) {
    filters.push(`type IN [${selectFilters.types.map((x) => `"${x}"`).join(',')}]`);
  }
  if (selectFilters.baseModels.length) {
    filters.push(
      `versions.baseModel IN [${selectFilters.baseModels.map((x) => `"${x}"`).join(',')}]`
    );
  }

  if (selectedTab === 'featured') {
    if (!!featuredModels) {
      filters.push(`id IN [${featuredModels.join(',')}]`);
    }
  } else if (selectedTab === 'recent') {
    if (selectSource === 'generation') {
      if (!!steps) {
        const usedResources = uniq(
          steps.flatMap(({ resources }) => resources.map((r) => r.model.id))
        );
        filters.push(`id IN [${usedResources.join(',')}]`);
      }
    } else if (selectSource === 'addResource') {
      if (!!manuallyAdded) {
        filters.push(`id IN [${manuallyAdded.join(',')}]`);
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
        filters.push(`id IN [${uniq(customModels).join(',')}]`);
      }
    } else if (selectSource === 'modelVersion') {
      if (!!recommendedModels) {
        filters.push(`id IN [${recommendedModels.join(',')}]`);
      }
    }
  } else if (selectedTab === 'liked') {
    if (!!likedModels) {
      filters.push(`id IN [${likedModels.join(',')}]`);
    }
  } else if (selectedTab === 'uploaded') {
    if (currentUser) {
      filters.push(`user.id = ${currentUser.id}`);
    }
  }

  const totalFilters = [...filters, ...exclude].join(' AND ');

  // console.log(totalFilters);

  function handleSelect(value: GenerationResource) {
    onSelect(value);
    dialog.onClose();
  }

  function handleClose() {
    dialog.onClose();
    onClose?.();
  }

  return (
    <Modal {...dialog} onClose={handleClose} size={1200} withCloseButton={false} padding={0}>
      <div className="flex size-full max-h-full max-w-full flex-col">
        <ResourceSelectContext.Provider value={{ onSelect: handleSelect, canGenerate, resources }}>
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
                <div className="flex shrink-0 flex-row gap-3">
                  <ResourceSelectSort />
                  <ResourceSelectFiltersDropdown
                    options={options}
                    selectFilters={selectFilters}
                    setSelectFilters={setSelectFilters}
                  />
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
                resources={resources}
                canGenerate={canGenerate}
                excludeIds={excludeIds}
                likes={likedModels}
                selectSource={selectSource}
              />
            )}
          </InstantSearch>
        </ResourceSelectContext.Provider>
      </div>
    </Modal>
  );
}

// TODO I don't think canGenerate and resources are being used here
const ResourceSelectContext = React.createContext<{
  canGenerate?: boolean;
  resources: { type: string; baseModels?: string[] }[];
  onSelect: (
    value: GenerationResource & { image: SearchIndexDataMap['models'][number]['images'][number] }
  ) => void;
} | null>(null);

const useResourceSelectContext = () => {
  const context = useContext(ResourceSelectContext);
  if (!context) throw new Error('missing ResourceSelectContext');
  return context;
};

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
  canGenerate,
  resources,
  excludeIds,
  likes,
  selectSource,
}: ResourceSelectOptions &
  Required<Pick<ResourceSelectOptions, 'resources' | 'excludeIds'>> & {
    likes: number[] | undefined;
    selectSource?: ResourceSelectSource;
  }) {
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

        const versions = model.versions.filter((version) => {
          return (
            (canGenerate ? canGenerate === version.canGenerate : true) &&
            (!!resourceType.baseModels?.length
              ? resourceType.baseModels.includes(version.baseModel)
              : true) &&
            !excludeIds.includes(version.id)
          );
        });
        if (!versions.length) return null;
        return { ...model, versions };
      })
      .filter(isDefined);
  }, [canGenerate, excludeIds, models, resources]);
  // console.log({ filtered });

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

  if (!items.length)
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

  return (
    // <ScrollArea id="resource-select-modal" className="flex-1 p-3">
    <div className="flex flex-col gap-3 p-3">
      {hiddenCount > 0 && (
        <Text color="dimmed">{hiddenCount} models have been hidden due to your settings.</Text>
      )}

      <div className={classes.grid}>
        {filtered
          .filter((model) => model.versions.length > 0)
          .map((model) => (
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
}: {
  data: SearchIndexDataMap['models'][number];
  isFavorite: boolean;
  selectSource?: ResourceSelectSource;
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
  const [selected, setSelected] = useState<number | undefined>(versions[0]?.id);
  const [flipped, setFlipped] = useState(false);

  const handleSelect = async () => {
    const version = versions.find((x) => x.id === selected);
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

  const selectedVersion = versions.find((x) => x.id === selected)!;
  const isSDXL = getIsSdxl(selectedVersion?.baseModel);
  const isPony = selectedVersion?.baseModel === 'Pony';
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

  return (
    // Visually hide card if there are no versions
    <TwCard
      className={clsx(classes.root, 'justify-between')}
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
                      <Link href={`/models/${data.id}?modelVersionId=${selected}`} target="_blank">
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
                    {!!currentUser && (
                      <div className="absolute bottom-2 right-2 flex items-center gap-1">
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
                      </div>
                    )}
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
              value={selected?.toString()}
              data={versions.map((version) => ({
                label: version.name,
                value: version.id.toString(),
              }))}
              onChange={(id) => setSelected(id !== null ? Number(id) : undefined)}
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
