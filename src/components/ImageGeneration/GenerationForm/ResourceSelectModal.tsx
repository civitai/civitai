import { ContextModalProps, openContextModal } from '@mantine/modals';
import { Generation } from '~/server/services/generation/generation.types';
import {
  Stack,
  Text,
  Group,
  Badge,
  Loader,
  Divider,
  Center,
  Box,
  Title,
  ThemeIcon,
  Menu,
  ActionIcon,
  Card,
  Select,
  Button,
} from '@mantine/core';
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { getDisplayName } from '~/utils/string-helpers';
import {
  Configure,
  InstantSearch,
  InstantSearchProps,
  useInfiniteHits,
  useInstantSearch,
  useRefinementList,
  useToggleRefinement,
} from 'react-instantsearch';
import {
  BaseModel,
  MODELS_SEARCH_INDEX,
  baseModelSets,
  constants,
} from '~/server/common/constants';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import { env } from '~/env/client.mjs';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useHiddenPreferencesContext } from '~/providers/HiddenPreferencesProvider';
import { applyUserPreferencesModels } from '~/components/Search/search.utils';
import { useInView } from 'react-intersection-observer';
import { IconCloudOff, IconDotsVertical } from '@tabler/icons-react';
import { useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import trieMemoize from 'trie-memoize';
import OneKeyMap from '@essentials/one-key-map';
import { FeedCard } from '~/components/Cards/FeedCard';
import { ResourceSelectOptions } from './resource-select.types';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useCardStyles } from '~/components/Cards/Cards.styles';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { CivitiaLinkManageButton } from '~/components/CivitaiLink/CivitiaLinkManageButton';
import HoverActionButton from '~/components/Cards/components/HoverActionButton';
import { aDayAgo } from '~/utils/date-helpers';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { openContext } from '~/providers/CustomModalsProvider';
import { IconTagOff } from '@tabler/icons-react';
import { IconInfoCircle } from '@tabler/icons-react';
import { ReportEntity } from '~/server/schema/report.schema';
import { CategoryTags } from '~/components/CategoryTags/CategoryTags';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

type ResourceSelectModalProps = {
  title?: React.ReactNode;
  notIds?: number[];
  onSelect: (value: Generation.Resource) => void;
  options?: ResourceSelectOptions;
};

export const openResourceSelectModal = ({ title, ...innerProps }: ResourceSelectModalProps) =>
  openContextModal({
    modal: 'resourceSelectModal',
    title,
    zIndex: 400,
    innerProps,
    size: 1200,
  });

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

const ResourceSelectContext = React.createContext<{
  onSelect: (value: Generation.Resource & { image: ResourceSelectData['image'] }) => void;
  canGenerate?: boolean;
} | null>(null);

const useResourceSelectContext = () => {
  const context = useContext(ResourceSelectContext);
  if (!context) throw new Error('missing ResourceSelectContext');
  return context;
};

export default function ResourceSelectModal({
  context,
  id,
  innerProps: { notIds = [], onSelect, options = {} },
}: ContextModalProps<ResourceSelectModalProps>) {
  const isMobile = useIsMobile();
  const features = useFeatureFlags();

  const { baseModel, types, canGenerate } = options;
  const baseModelSet = baseModel
    ? Object.entries(baseModelSets).find(
        ([key, set]) => key === baseModel || set.includes(baseModel as BaseModel)
      )?.[1]
    : undefined;

  const filters: string[] = [];
  if (types) filters.push(`(${types.map((type) => `type = ${type}`).join(' OR ')})`);
  if (canGenerate !== undefined) filters.push(`canGenerate = ${canGenerate}`);
  if (baseModelSet)
    filters.push(
      `(${baseModelSet.map((baseModel) => `version.baseModel = '${baseModel}'`).join(' OR ')})`
    );

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
      value={{ onSelect: handleSelect, canGenerate: options.canGenerate }}
    >
      <InstantSearch searchClient={searchClient} indexName={MODELS_SEARCH_INDEX}>
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
  const currentUser = useCurrentUser();
  const { status } = useInstantSearch();
  const { classes } = useSearchLayoutStyles();
  const { hits, showMore, isLastPage } = useInfiniteHits<ModelSearchIndexRecord>();
  const {
    models: hiddenModels,
    images: hiddenImages,
    tags: hiddenTags,
    users: hiddenUsers,
    isLoading: loadingPreferences,
  } = useHiddenPreferencesContext();

  const models = useMemo(() => {
    return applyUserPreferencesModels({
      items: hits,
      hiddenModels,
      hiddenImages,
      hiddenTags,
      hiddenUsers,
      currentUserId: currentUser?.id,
    });
  }, [hits, hiddenModels, hiddenImages, hiddenTags, hiddenUsers, currentUser]);

  const hiddenItems = hits.length - models.length;
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
            {hiddenItems > 0 && (
              <Text color="dimmed">
                {hiddenItems} models have been hidden due to your settings.
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
      {hiddenItems > 0 && (
        <Text color="dimmed">{hiddenItems} models have been hidden due to your settings.</Text>
      )}
      <Box className={classes.grid}>
        {models.map((model, index) => {
          return (
            <div key={model.id.toString()} id={model.id.toString()}>
              {createRenderElement(ResourceSelectCard, index, model)}
            </div>
          );
        })}
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
type ResourceSelectData = ReturnType<
  typeof applyUserPreferencesModels<ModelSearchIndexRecord>
>[number];

function ResourceSelectCard({ index, data }: { index: number; data: ResourceSelectData }) {
  const currentUser = useCurrentUser();
  const { ref, inView } = useInView({ rootMargin: '600px' });
  const { onSelect, canGenerate } = useResourceSelectContext();
  const { classes, cx, theme } = useCardStyles({
    aspectRatio:
      data.image && data.image.width && data.image.height
        ? data.image.width / data.image.height
        : 1,
  });
  const versions = data.versions.filter((x) =>
    canGenerate !== undefined ? x.canGenerate === canGenerate : true
  );
  const [selected, setSelected] = useState<number | undefined>(versions[0]?.id);

  const handleSelect = () => {
    const version = data.versions.find((x) => x.id === selected);
    if (!version) return;
    const { id, name, trainedWords, baseModel } = version;

    onSelect({
      id,
      name,
      trainedWords,
      baseModel,
      modelId: data.id,
      modelName: data.name,
      modelType: data.type,
      image: data.image,
      strength: 1, // TODO - use version recommendations or default to 1
    });
  };

  const isSDXL = baseModelSets.SDXL.includes(data.version?.baseModel as BaseModel);
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
            entityId: data.image.id,
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
    <FeedCard ref={ref}>
      {inView && (
        <div className={classes.root} onClick={handleSelect}>
          <ImageGuard
            images={[data.image]}
            connect={{ entityId: data.id, entityType: 'model' }}
            render={(image) => (
              <ImageGuard.Content>
                {({ safe }) => {
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
                          <ImageGuard.ToggleConnect className={classes.chip} position="static" />
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
                                <Text color="white" size="xs">
                                  XL
                                </Text>
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
                          <CivitiaLinkManageButton
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
                          </CivitiaLinkManageButton>
                        </Stack>
                      </Group>
                      {safe ? (
                        <EdgeMedia
                          src={image.url}
                          name={image.name ?? image.id.toString()}
                          alt={image.name ?? undefined}
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
                        <MediaHash {...data.image} />
                      )}
                    </>
                  );
                }}
              </ImageGuard.Content>
            )}
          />
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
      )}
    </FeedCard>
  );
}
