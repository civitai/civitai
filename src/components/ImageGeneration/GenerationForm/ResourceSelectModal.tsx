import OneKeyMap from '@essentials/one-key-map';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Center,
  Divider,
  Group,
  Loader,
  Menu,
  Select,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { ContextModalProps, openContextModal } from '@mantine/modals';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { ModelType } from '@prisma/client';
import {
  IconCloudOff,
  IconDotsVertical,
  IconHorse,
  IconInfoCircle,
  IconTagOff,
} from '@tabler/icons-react';
import { truncate } from 'lodash-es';
import React, { useContext, useEffect, useRef, useState } from 'react';
import {
  Configure,
  InstantSearch,
  InstantSearchProps,
  useInstantSearch,
  useRefinementList,
} from 'react-instantsearch';
import trieMemoize from 'trie-memoize';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { FeedCard } from '~/components/Cards/FeedCard';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { CivitaiLinkManageButton } from '~/components/CivitaiLink/CivitaiLinkManageButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { getBaseModelSet } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import { searchIndexMap } from '~/components/Search/search.types';
import { SearchIndexDataMap, useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useInView } from '~/hooks/useInView';
import { useIsMobile } from '~/hooks/useIsMobile';
import { openContext } from '~/providers/CustomModalsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { BaseModel, baseModelSets, constants } from '~/server/common/constants';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ReportEntity } from '~/server/schema/report.schema';
import { Generation } from '~/server/services/generation/generation.types';
import { aDayAgo } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { ResourceSelectOptions } from './resource-select.types';

type ResourceSelectModalProps = {
  title?: React.ReactNode;
  onSelect: (value: Generation.Resource) => void;
  onClose?: () => void;
  options?: ResourceSelectOptions;
  isTraining?: boolean;
};

export const openResourceSelectModal = ({
  title,
  onClose,
  ...innerProps
}: ResourceSelectModalProps) =>
  openContextModal({
    modal: 'resourceSelectModal',
    title,
    zIndex: 400,
    innerProps,
    size: 1200,
    onClose,
  });

const ResourceSelectContext = React.createContext<{
  canGenerate?: boolean;
  isTraining?: boolean;
  resources: { type: ModelType; baseModels: BaseModel[] }[];
  onSelect: (
    value: Generation.Resource & { image: SearchIndexDataMap['models'][number]['images'][number] }
  ) => void;
} | null>(null);

const useResourceSelectContext = () => {
  const context = useContext(ResourceSelectContext);
  if (!context) throw new Error('missing ResourceSelectContext');
  return context;
};

export default function ResourceSelectModal({
  context,
  id,
  innerProps: { onSelect, options = {}, isTraining = false },
}: ContextModalProps<ResourceSelectModalProps>) {
  const isMobile = useIsMobile();
  const features = useFeatureFlags();

  const { resources = [], canGenerate } = options;
  const _resources = resources?.map(({ type, baseModelSet, baseModels }) => {
    let aggregate: BaseModel[] = [];
    if (baseModelSet) aggregate = getBaseModelSet(baseModelSet) ?? [];
    if (baseModels) aggregate = [...new Set([...aggregate, ...baseModels])];
    return { type, baseModels: aggregate };
  });

  const filters: string[] = [];
  if (canGenerate !== undefined) filters.push(`canGenerate = ${canGenerate}`);
  if (!!_resources.length) {
    const innerFilter: string[] = [];
    for (const { type, baseModels } of _resources) {
      if (!baseModels.length) innerFilter.push(`type = ${type}`);
      else
        innerFilter.push(
          `(${baseModels
            .map((baseModel) => `(type = ${type} AND version.baseModel = '${baseModel}')`)
            .join(' OR ')})`
          //TODO - use IN instead of OR
        );
    }
    filters.push(`(${innerFilter.join(' OR ')})`);
  }

  const exclude: string[] = [];
  exclude.push('NOT tags.name = "celebrity"');
  if (!features.sdxlGeneration) {
    for (const baseModel in baseModelSets.SDXL) {
      exclude.push(`NOT version.baseModel = ${baseModel}`);
    }
  }

  const handleSelect = (value: Generation.Resource) => {
    onSelect(value);
    context.closeModal(id);
  };

  return (
    <ResourceSelectContext.Provider
      value={{ onSelect: handleSelect, canGenerate, isTraining, resources: _resources }}
    >
      <InstantSearch
        searchClient={searchClient}
        indexName={searchIndexMap.models}
        future={{ preserveSharedStateOnUnmount: true }}
      >
        <Configure hitsPerPage={20} filters={[...filters, ...exclude].join(' AND ')} />
        <Stack>
          <CustomSearchBox isMobile={isMobile} autoFocus />
          <CategoryTagFilters />
          <ResourceHitList />
        </Stack>
      </InstantSearch>
    </ResourceSelectContext.Provider>
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
    />
  );
}

function ResourceHitList() {
  const startedRef = useRef(false);
  // const currentUser = useCurrentUser();
  const { status } = useInstantSearch();
  const { classes } = useSearchLayoutStyles();
  const { hits, showMore, isLastPage } = useInfiniteHitsTransformed<'models'>();
  const {
    items: models,
    loadingPreferences,
    hiddenCount,
  } = useApplyHiddenPreferences({
    type: 'models',
    data: hits,
  });
  const loading =
    status === 'loading' || status === 'stalled' || loadingPreferences || !startedRef.current;

  useEffect(() => {
    if (!startedRef.current && status !== 'idle') startedRef.current = true;
  }, [status]);

  if (loading && !hits.length)
    return (
      <Box>
        <Center mt="md">
          <Loader />
        </Center>
      </Box>
    );

  if (!hits.length)
    return (
      <Box>
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
      </Box>
    );

  return (
    <Stack>
      {hiddenCount > 0 && (
        <Text color="dimmed">{hiddenCount} models have been hidden due to your settings.</Text>
      )}
      <Box className={classes.grid}>
        {models.map((model, index) => createRenderElement(ResourceSelectCard, index, model))}
      </Box>
      {hits.length > 0 && !isLastPage && (
        <InViewLoader loadFn={showMore} loadCondition={status === 'idle'}>
          <Center sx={{ height: 36 }} mt="md">
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Stack>
  );
}

const createRenderElement = trieMemoize(
  [OneKeyMap, {}, WeakMap],
  (RenderComponent, index, model) => <RenderComponent key={model.id} index={index} data={model} />
);

const IMAGE_CARD_WIDTH = 450;

function ResourceSelectCard({
  data,
}: {
  index: number;
  data: SearchIndexDataMap['models'][number];
}) {
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView({ rootMargin: '600px' });
  const { onSelect, canGenerate, isTraining, resources } = useResourceSelectContext();
  const image = data.images[0];
  const { classes, cx } = useCardStyles({
    aspectRatio: image && image.width && image.height ? image.width / image.height : 1,
  });

  const resourceFilter = resources.find((x) => x.type === data.type);
  const versions = data.versions.filter((version) => {
    if (isTraining && !['SD 1.4', 'SD 1.5', 'SDXL 1.0', 'Pony'].includes(version.baseModel))
      return false;
    if (canGenerate === undefined) return true;
    return (
      version.canGenerate === canGenerate &&
      (resourceFilter?.baseModels?.length
        ? resourceFilter.baseModels?.includes(version.baseModel as BaseModel)
        : true)
    );
  });
  const [selected, setSelected] = useState<number | undefined>(versions[0]?.id);

  const handleSelect = () => {
    const version = data.versions.find((x) => x.id === selected);
    if (!version) return;
    const { id, name, trainedWords, baseModel, settings } = version;

    onSelect({
      id,
      name,
      trainedWords,
      baseModel,
      modelId: data.id,
      modelName: data.name,
      modelType: data.type,
      image: image,
      covered: data.canGenerate,
      strength: settings?.strength ?? 1,
      minStrength: settings?.minStrength ?? -1,
      maxStrength: settings?.maxStrength ?? 2,
    });
  };

  const selectedVersion = data.versions.find((x) => x.id === selected);
  const isSDXL = [...baseModelSets.SDXL, ...baseModelSets.Pony].includes(
    selectedVersion?.baseModel as BaseModel
  );
  const isPony = selectedVersion?.baseModel === 'Pony';
  const isNew = data.publishedAt && data.publishedAt > aDayAgo;
  const isUpdated =
    data.lastVersionAt &&
    data.publishedAt &&
    data.lastVersionAt > aDayAgo &&
    data.lastVersionAt.getTime() - data.publishedAt.getTime() > constants.timeCutOffs.updatedModel;

  let contextMenuItems: React.ReactNode[] = [];

  // if (features.collections) {
  //   contextMenuItems = contextMenuItems.concat([
  //     <AddToCollectionMenuItem
  //       key="add-to-collection"
  //       onClick={() =>
  //         openContext('addToCollection', { modelId: data.id, type: CollectionType.Model })
  //       }
  //     />,
  //   ]);
  // }

  if (currentUser?.id !== data.user.id)
    contextMenuItems = contextMenuItems.concat([
      <HideModelButton key="hide-model" as="menu-item" modelId={data.id} />,
      <HideUserButton key="hide-button" as="menu-item" userId={data.user.id} />,
      <ReportMenuItem
        key="report-model"
        loginReason="report-model"
        onReport={() =>
          openContext('report', { entityType: ReportEntity.Model, entityId: data.id })
        }
      />,
      <ReportMenuItem
        key="report-image"
        label="Report image"
        onReport={() =>
          openContext('report', {
            entityType: ReportEntity.Image,
            // Explicitly cast to number because we know it's not undefined
            entityId: image.id,
          })
        }
      />,
    ]);
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
    // Visually hide card if there are no versions
    <FeedCard ref={ref} style={{ display: versions.length === 0 ? 'none' : undefined }}>
      {inView ? (
        <div className={classes.root} onClick={handleSelect}>
          {image && (
            <ImageGuard2 image={image} connectType="model" connectId={data.id}>
              {(safe) => {
                const originalAspectRatio =
                  image.width && image.height ? image.width / image.height : 1;

                return (
                  <>
                    <Group
                      spacing={4}
                      position="apart"
                      align="start"
                      className={cx(classes.contentOverlay, classes.top)}
                      noWrap
                    >
                      <Group spacing={4}>
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
                      </Group>
                      <Stack spacing="xs">
                        {contextMenuItems.length > 0 && (
                          <Menu position="left-start" withArrow offset={-5}>
                            <Menu.Target>
                              <ActionIcon
                                variant="transparent"
                                p={0}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                              >
                                <IconDotsVertical
                                  size={24}
                                  color="#fff"
                                  style={{ filter: `drop-shadow(0 0 2px #000)` }}
                                />
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
                      </Stack>
                    </Group>
                    {safe ? (
                      <EdgeMedia
                        src={image.url}
                        name={image.name ?? image.id.toString()}
                        alt={
                          image.meta
                            ? truncate((image.meta as ImageMetaProps).prompt, {
                                length: constants.altTruncateLength,
                              })
                            : image.name ?? undefined
                        }
                        type={image.type}
                        width={
                          originalAspectRatio > 1
                            ? IMAGE_CARD_WIDTH * originalAspectRatio
                            : IMAGE_CARD_WIDTH
                        }
                        placeholder="empty"
                        className={classes.image}
                        loading="lazy"
                      />
                    ) : (
                      <MediaHash {...image} />
                    )}
                  </>
                );
              }}
            </ImageGuard2>
          )}

          <Card
            sx={{ position: 'absolute', bottom: 0, left: 0, right: 0, overflow: 'visible' }}
            radius={0}
          >
            <Stack>
              <Text size="sm" weight={700} lineClamp={1} lh={1}>
                {data.name}
              </Text>
              <Group noWrap position="apart">
                {versions.length === 1 ? (
                  <span>{versions[0].name}</span>
                ) : (
                  <Select
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    value={selected?.toString()}
                    data={versions.map((version) => ({
                      label: version.name,
                      value: version.id.toString(),
                    }))}
                    onChange={(id) => setSelected(id !== null ? Number(id) : undefined)}
                  />
                )}
                <Button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleSelect();
                  }}
                >
                  Select
                </Button>
              </Group>
            </Stack>
          </Card>
        </div>
      ) : (
        <></>
      )}
    </FeedCard>
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
