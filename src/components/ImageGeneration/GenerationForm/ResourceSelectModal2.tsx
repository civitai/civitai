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
  Select,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { instantMeiliSearch } from '@meilisearch/instant-meilisearch';
import {
  IconCloudOff,
  IconDotsVertical,
  IconHorse,
  IconInfoCircle,
  IconTagOff,
} from '@tabler/icons-react';
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
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { HideModelButton } from '~/components/HideModelButton/HideModelButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import { searchIndexMap } from '~/components/Search/search.types';
import { SearchIndexDataMap, useInfiniteHitsTransformed } from '~/components/Search/search.utils2';
import { useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { TwCard } from '~/components/TwCard/TwCard';
import { env } from '~/env/client.mjs';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { openContext } from '~/providers/CustomModalsProvider';
import { constants } from '~/server/common/constants';
import { ReportEntity } from '~/server/schema/report.schema';
import { Generation } from '~/server/services/generation/generation.types';
import { GenerationResource, getIsSdxl } from '~/shared/constants/generation.constants';
import { aDayAgo } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { ResourceSelectOptions } from './resource-select.types';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import clsx from 'clsx';
import { isDefined } from '~/utils/type-guards';

export type ResourceSelectModalProps = {
  title?: React.ReactNode;
  onSelect: (value: Generation.Resource) => void;
  onClose?: () => void;
  options?: ResourceSelectOptions;
};

export default function ResourceSelectModal({
  title,
  onSelect,
  onClose,
  options = {},
}: ResourceSelectModalProps) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile();
  const { resources = [], canGenerate } = options;

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
  if (or.length) filters.push(or.join(' OR '));

  const exclude: string[] = [];
  exclude.push('NOT tags.name = "celebrity"');

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
      <div className="flex size-full max-h-full max-w-full flex-col overflow-hidden">
        <ResourceSelectContext.Provider value={{ onSelect: handleSelect, canGenerate, resources }}>
          <InstantSearch
            searchClient={searchClient}
            indexName={searchIndexMap.models}
            future={{ preserveSharedStateOnUnmount: true }}
          >
            <Configure hitsPerPage={20} filters={[...filters, ...exclude].join(' AND ')} />
            <div className="flex flex-col gap-3 p-3">
              <div className="flex items-center justify-between">
                <Text>{title}</Text>
                <CloseButton onClick={handleClose} />
              </div>
              <CustomSearchBox isMobile={isMobile} autoFocus />
              <CategoryTagFilters />
            </div>
            <ResourceHitList resourceTypes={resources} canGenerate={canGenerate} />
          </InstantSearch>
        </ResourceSelectContext.Provider>
      </div>
    </Modal>
  );
}

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
    />
  );
}

function ResourceHitList({
  canGenerate,
  resourceTypes,
}: {
  canGenerate?: boolean;
  resourceTypes: { type: string; baseModels?: string[] }[];
}) {
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

  const filtered = useMemo(() => {
    if (!canGenerate && !resourceTypes.length) return models;

    return models
      .map((model) => {
        const resourceType = resourceTypes.find((x) => x.type === model.type);
        if (!resourceType) return null;

        const versions = model.versions.filter((version) => {
          return (
            (canGenerate ? canGenerate === version.canGenerate : true) &&
            (!!resourceType.baseModels?.length
              ? resourceType.baseModels.includes(version.baseModel)
              : true)
          );
        });
        if (!versions.length) return null;
        return { ...model, versions };
      })
      .filter(isDefined);
  }, [canGenerate, models, resourceTypes]);

  useEffect(() => {
    if (!startedRef.current && status !== 'idle') startedRef.current = true;
  }, [status]);

  if (loading && !hits.length)
    return (
      <div className="p-3 py-5">
        <Center mt="md">
          <Loader />
        </Center>
      </div>
    );

  if (!hits.length)
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
            <ResourceSelectCard key={model.id} data={model} />
          ))}
      </div>
      {hits.length > 0 && !isLastPage && (
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

function ResourceSelectCard({ data }: { data: SearchIndexDataMap['models'][number] }) {
  const currentUser = useCurrentUser();
  // const [ref, inView] = useInViewDynamic({ id: data.id.toString() });
  const { onSelect } = useResourceSelectContext();
  const image = data.images[0];
  const { classes, cx } = useCardStyles({
    aspectRatio: image && image.width && image.height ? image.width / image.height : 1,
  });

  const versions = data.versions;
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
      minor: data.minor,
      image: image,
      covered: data.canGenerate,
      available:
        data.canGenerate && (data.availability === 'Public' || data.availability === 'Private'),
      strength: settings?.strength ?? 1,
      minStrength: settings?.minStrength ?? -1,
      maxStrength: settings?.maxStrength ?? 2,
    });
  };

  const selectedVersion = data.versions.find((x) => x.id === selected);
  const isSDXL = getIsSdxl(selectedVersion?.baseModel);
  const isPony = selectedVersion?.baseModel === 'Pony';
  const isNew = data.publishedAt && data.publishedAt > aDayAgo;
  const isUpdated =
    data.lastVersionAt &&
    data.publishedAt &&
    data.lastVersionAt > aDayAgo &&
    data.lastVersionAt.getTime() - data.publishedAt.getTime() > constants.timeCutOffs.updatedModel;

  let contextMenuItems: React.ReactNode[] = [];

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

  const originalAspectRatio = image.width && image.height ? image.width / image.height : 1;
  const width = originalAspectRatio > 1 ? IMAGE_CARD_WIDTH * originalAspectRatio : IMAGE_CARD_WIDTH;

  return (
    // Visually hide card if there are no versions
    <TwCard
      className={clsx(classes.root, 'justify-between')}
      onClick={handleSelect}
      style={{ display: versions.length === 0 ? 'none' : undefined }}
    >
      {/* {inView && ( */}
      <>
        {image && (
          <ImageGuard2 image={image} connectType="model" connectId={data.id}>
            {(safe) => {
              return (
                <div className="relative overflow-hidden aspect-portrait">
                  {safe ? (
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
                  <div className="absolute right-2 top-2 flex flex-col gap-1">
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
                  </div>
                </div>
              );
            }}
          </ImageGuard2>
        )}

        <div className="flex flex-col gap-2 p-3">
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
