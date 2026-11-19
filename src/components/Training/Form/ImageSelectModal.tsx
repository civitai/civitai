import type { OutputUse } from '~/shared/generation/config/types';
import {
  Accordion,
  ActionIcon,
  Badge,
  Button,
  Center,
  Checkbox,
  CloseButton,
  Divider,
  Group,
  Loader,
  Modal,
  Overlay,
  Stack,
  Text,
  Title,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import {
  IconCategory,
  IconDownload,
  IconExternalLink,
  IconHash,
  IconInfoCircle,
  IconTags,
} from '@tabler/icons-react';
import type { FetchNextPageOptions } from '@tanstack/react-query';
import { groupBy } from 'lodash-es';
import React, { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { Props as DescriptionTableProps } from '~/components/DescriptionTable/DescriptionTable';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { IconBadge } from '~/components/IconBadge/IconBadge';
import type {
  ImageSelectProfileFilter,
  ImageSelectSource,
  ImageSelectTrainingFilter,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { getStepMeta } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { MarkerFiltersDropdown } from '~/components/ImageGeneration/MarkerFiltersDropdown';
import {
  matchesMarkerTags,
  useGetTextToImageRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import {
  ImageSelectFiltersProfileDropdown,
  ImageSelectFiltersTrainingDropdown,
} from '~/components/Training/Form/ImageSelectFilters';
import { TwCard } from '~/components/TwCard/TwCard';
import { trainingStatusFields } from '~/shared/constants/training.constants';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import { imageMetaSchema } from '~/server/schema/image.schema';
import type {
  TrainingDetailsBaseModelList,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import type {
  AudioBlob,
  BlobData,
  ImageBlob,
  VideoBlob,
} from '~/shared/orchestrator/workflow-data';

// Training never accepts 3D outputs; alias the 2D-only subset of BlobData
// to keep `img.type` narrowed to MediaType for downstream EdgeMedia / SelectedImage.
type TrainingGenerationBlob = ImageBlob | VideoBlob | AudioBlob;
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { MediaType, TrainingStatus } from '~/shared/utils/prisma/enums';
import type { ImageGetMyInfinite, RecentTrainingData } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { isAir, splitUppercase } from '~/utils/string-helpers';
import { getAirModelLink } from '~/shared/utils/air';
import { trainingModelInfo } from '~/utils/training';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import styles from '~/components/Search/SearchLayout.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import { createSelectionContext, createSelectionStore } from '~/store/createSelectionStore';

// const take = 20;

export type SelectedImage = {
  url: string;
  label: string;
  type: MediaType;
  meta?: Record<string, unknown>;
  /** Generator selections only — lets the server verify what the job was made from. */
  generationWorkflowId?: string;
};

type UploadedImage = Omit<ImageGetMyInfinite[number], 'meta'> & { meta: ImageMetaProps | null };
type TrainedData = Omit<RecentTrainingData[number], 'metadata' | 'modelVersion'> & {
  metadata: FileMetadata | null;
  modelVersion: Omit<RecentTrainingData[number]['modelVersion'], 'trainingDetails'> & {
    trainingDetails: TrainingDetailsObj | null;
  };
};

type GridItem =
  | { type: 'generation'; img: TrainingGenerationBlob }
  | { type: 'uploaded'; img: UploadedImage }
  | { type: 'training'; img: TrainedData };

const getItemKey = (item: GridItem) =>
  item.type === 'training' ? `${item.img.modelVersion.id}` : item.img.url;

function getItemDate(item: GridItem) {
  if (item.type !== 'generation') return item.img.createdAt;
  return item.img.step.completedAt ? new Date(item.img.step.completedAt) : undefined;
}

function toSelectedImage(item: GridItem): SelectedImage {
  switch (item.type) {
    case 'generation':
      return {
        url: item.img.url,
        label: ((item.img.step.params as any)?.prompt as string) ?? '',
        type: item.img.type,
        meta: getStepMeta(item.img.step),
        generationWorkflowId: item.img.workflowId,
      };
    case 'uploaded':
      return {
        url: item.img.url,
        label: item.img.meta?.prompt ?? '',
        type: item.img.type,
        meta: (item.img.meta as Record<string, unknown> | null) ?? undefined,
      };
    case 'training':
      return { url: getItemKey(item), label: '', type: MediaType.image };
  }
}

const { SelectionProvider, useActions, useIsSelected, useRegisterOrder } =
  createSelectionContext<GridItem>();

export type ImageSelectModalProps = {
  title?: React.ReactNode;
  onSelect: (data: SelectedImage[]) => void;
  importedUrls: string[];
  videoAllowed: boolean;
  selectSource?: ImageSelectSource;
  /** What the picked outputs are for; outputs that can't be used for it aren't listed. */
  outputUse?: OutputUse;
};

export default function ImageSelectModal({
  title,
  onSelect,
  importedUrls,
  videoAllowed,
  selectSource = 'generation',
  outputUse = 'post',
}: ImageSelectModalProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();

  const [selection] = useState(() => createSelectionStore<GridItem>({ getKey: getItemKey }));
  const selectedCount = useStore(selection.store, (state) => Object.keys(state.selected).length);
  const [selectTrainingFilters, setSelectTrainingFilters] = useState<ImageSelectTrainingFilter>({
    hasLabels: null,
    labelType: null,
    statuses: [],
    types: [],
    mediaTypes: [],
    baseModels: [],
  });
  const [selectProfileFilters, setSelectProfileFilters] = useState<ImageSelectProfileFilter>({
    mediaTypes: videoAllowed ? [] : [MediaType.image],
  });

  const {
    data: generationData,
    isFetching: isLoadingGenerations,
    isFetchingNextPage: isFetchingNextPageGenerations,
    hasNextPage: hasNextPageGenerations,
    fetchNextPage: fetchNextPageGenerations,
    markerTags,
    // isError: isErrorGenerations,
  } = useGetTextToImageRequests(
    { tags: videoAllowed ? [] : [WORKFLOW_TAGS.IMAGE] },
    { enabled: !!currentUser && selectSource === 'generation' }
  );

  const {
    data: dataUploaded,
    isFetching: isLoadingUploaded,
    isFetchingNextPage: isFetchingNextPageUploaded,
    hasNextPage: hasNextPageUploaded,
    fetchNextPage: fetchNextPageUploaded,
    // isError: isErrorUploaded,
  } = trpc.image.getMyImages.useInfiniteQuery(selectProfileFilters, {
    enabled: !!currentUser && selectSource === 'uploaded',
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  // TODO debounce filters
  // TODO only allow video types for videoAllowed
  const {
    data: dataTraining,
    isFetching: isLoadingTraining,
    isFetchingNextPage: isFetchingNextPageTraining,
    hasNextPage: hasNextPageTraining,
    fetchNextPage: fetchNextPageTraining,
    // isError: isErrorTraining,
  } = trpc.modelFile.getRecentTrainingData.useInfiniteQuery(selectTrainingFilters, {
    enabled: !!currentUser && selectSource === 'training',
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });

  const generatedMedia = useMemo(
    () =>
      (generationData ?? []).flatMap((wf) =>
        // Training datasets only accept 2D media; PolyGen (3D) outputs
        // have no sensible representation here.
        wf.succeededOutput.filter(
          (x): x is TrainingGenerationBlob =>
            x.available &&
            x.type !== 'model3d' &&
            matchesMarkerTags(x, markerTags) &&
            x.canUse(outputUse)
        )
      ),
    [generationData, markerTags, outputUse]
  );

  const uploadedMedia = useMemo(
    () =>
      (dataUploaded?.pages.flatMap((x) => (!!x ? x.items : [])) ?? []).map((d) => ({
        ...d,
        meta: d.meta as ImageMetaProps | null,
      })),
    [dataUploaded]
  );

  const trainingFiles = useMemo(
    () =>
      (dataTraining?.pages.flatMap((x) => (!!x ? x.items : [])) ?? []).map((d) => {
        return {
          ...d,
          metadata: d.metadata as FileMetadata | null,
          modelVersion: {
            ...d.modelVersion,
            trainingDetails: d.modelVersion.trainingDetails as TrainingDetailsObj | null,
          },
        };
      }),
    [dataTraining]
  );

  const gridItems = useMemo((): GridItem[] => {
    if (selectSource === 'generation')
      return generatedMedia.map((img) => ({ type: 'generation', img }));
    if (selectSource === 'uploaded') return uploadedMedia.map((img) => ({ type: 'uploaded', img }));
    if (selectSource === 'training') return trainingFiles.map((img) => ({ type: 'training', img }));
    return [];
  }, [selectSource, generatedMedia, uploadedMedia, trainingFiles]);

  let isLoading: boolean;
  let isFetchingNext: boolean;
  let hasNextPage: boolean;
  let fetchNextPage: (options?: FetchNextPageOptions) => Promise<any>;

  if (selectSource === 'generation') {
    isLoading = isLoadingGenerations;
    isFetchingNext = isFetchingNextPageGenerations;
    hasNextPage = !!hasNextPageGenerations;
    fetchNextPage = fetchNextPageGenerations;
  } else if (selectSource === 'uploaded') {
    isLoading = isLoadingUploaded;
    isFetchingNext = isFetchingNextPageUploaded;
    hasNextPage = !!hasNextPageUploaded;
    fetchNextPage = fetchNextPageUploaded;
  } else if (selectSource === 'training') {
    isLoading = isLoadingTraining;
    isFetchingNext = isFetchingNextPageTraining;
    hasNextPage = !!hasNextPageTraining;
    fetchNextPage = fetchNextPageTraining;
  } else {
    isLoading = false;
    isFetchingNext = false;
    hasNextPage = false;
    fetchNextPage = async () => null;
  }

  function handleSelect() {
    onSelect(selection.actions.getSelected().map(toSelectedImage));
    dialog.onClose();
  }

  function handleClose() {
    dialog.onClose();
  }

  return (
    <Modal {...dialog} onClose={handleClose} size={1200} withCloseButton={false} padding={0}>
      <SelectionProvider store={selection}>
        <div className="flex size-full max-h-full max-w-full flex-col bg-gray-0 dark:bg-dark-7">
          <div className="sticky top-[-48px] z-30 flex flex-col gap-3 bg-gray-0 p-3  dark:bg-dark-7">
            <div className="flex flex-wrap items-center justify-between gap-4 sm:gap-10">
              <Text>{title}</Text>
              {/*<CustomSearchBox*/}
              {/*  isMobile={isMobile}*/}
              {/*  autoFocus*/}
              {/*  className="order-last w-full grow sm:order-none sm:w-auto"*/}
              {/*/>*/}
              <CloseButton onClick={handleClose} />
            </div>

            <Group justify="space-between">
              <Group>
                <Button onClick={handleSelect} disabled={!selectedCount}>{`Import${
                  selectedCount > 0 ? ` (${selectedCount})` : ''
                }`}</Button>
                <Button variant="light" onClick={selection.actions.clear} disabled={!selectedCount}>
                  Deselect All
                </Button>
              </Group>
              {selectSource === 'generation' && (
                <MarkerFiltersDropdown
                  text="Filters"
                  position="bottom-end"
                  hideMediaTypes={!videoAllowed}
                />
              )}
              {selectSource === 'training' && (
                <ImageSelectFiltersTrainingDropdown
                  selectFilters={selectTrainingFilters}
                  setSelectFilters={setSelectTrainingFilters}
                />
              )}
              {selectSource === 'uploaded' && videoAllowed && (
                <ImageSelectFiltersProfileDropdown
                  selectFilters={selectProfileFilters}
                  setSelectFilters={setSelectProfileFilters}
                />
              )}
            </Group>

            <Divider />
          </div>

          {isLoading && !isFetchingNext ? (
            <div className="p-3 py-5">
              <Center mt="md">
                <Loader />
              </Center>
            </div>
          ) : (
            <div className="flex flex-col gap-3 p-3">
              <ImageGrid
                items={gridItems}
                importedUrls={importedUrls}
                isTraining={selectSource === 'training'}
              />
              {hasNextPage && (
                <InViewLoader
                  loadFn={fetchNextPage}
                  loadCondition={!isLoading && !isFetchingNext && hasNextPage}
                >
                  <Center p="xl" style={{ height: 36 }} mt="md">
                    <Loader />
                  </Center>
                </InViewLoader>
              )}
            </div>
          )}
        </div>
      </SelectionProvider>
    </Modal>
  );
}

const ImageGrid = ({
  items,
  importedUrls,
  isTraining,
}: {
  items: GridItem[];
  importedUrls: string[];
  isTraining: boolean;
}) => {
  const isSelectable = (item: GridItem) => !importedUrls.includes(getItemKey(item));

  const grouped = useMemo(
    () =>
      groupBy(items, (item) => {
        const date = getItemDate(item);
        return date
          ? date.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
          : 'Unknown Date';
      }),
    [items]
  );

  useRegisterOrder('images', Object.values(grouped).flat().filter(isSelectable));

  if (!items.length)
    return <NoContent message={`No ${isTraining ? 'datasets' : 'assets'} found`} />;

  return (
    <Stack>
      {Object.entries(grouped).map(([date, groupItems], index) => (
        <Stack key={index}>
          <Title order={4} className="mb-2">
            {date}
          </Title>
          <div
            className={clsx('p-2', styles.grid)}
            style={
              isTraining ? { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' } : {}
            }
          >
            {groupItems.map((item) => (
              <ImageGridMedia
                key={
                  item.type === 'generation'
                    ? `${item.img.workflowId}_${item.img.stepName}_${item.img.id}`
                    : item.img.id
                }
                item={item}
                selectable={isSelectable(item)}
              />
            ))}
          </div>
        </Stack>
      ))}
    </Stack>
  );
};

const ImageGridMedia = ({ item, selectable }: { item: GridItem; selectable: boolean }) => {
  const { type, img } = item;
  const { select } = useActions();
  const isSelected = useIsSelected(item);
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const onChange = (e: React.MouseEvent) => {
    if (!selectable) return;
    select(item, { shiftKey: e.shiftKey, checked: !isSelected });
  };

  if (type === 'training') {
    const {
      url,
      sizeKB,
      createdAt,
      metadata,
      modelVersion: { id: versionId, trainingStatus, trainingDetails },
    } = img;
    const type = trainingDetails?.type;
    const baseModel = trainingDetails?.baseModel;
    const params = trainingDetails?.params;

    const modelDetails: DescriptionTableProps['items'] = [
      {
        label: 'Status',
        value: trainingStatus ? (
          <Badge color={trainingStatusFields[trainingStatus]?.color ?? 'gray'}>
            <Group gap={6} wrap="nowrap">
              {splitUppercase(
                trainingStatus === TrainingStatus.InReview ? 'Ready' : trainingStatus
              )}
              {trainingStatus === TrainingStatus.Submitted ||
              trainingStatus === TrainingStatus.Processing ? (
                <Loader size={12} />
              ) : (
                <></>
              )}
            </Group>
          </Badge>
        ) : (
          <Badge color="gray">Unknown</Badge>
        ),
      },
      {
        label: 'Created',
        value: formatDate(createdAt, 'MMM D, YYYY hh:mm:ss A'),
      },
      {
        label: 'Type',
        value: type ?? '-',
      },
      {
        label: 'Files',
        value: (
          <Group gap="xs">
            <IconBadge color="pink" icon={<IconHash size={14} />} tooltip="Number of files">
              {metadata?.numImages || 0}
            </IconBadge>
            <IconBadge color="violet" icon={<IconTags size={14} />} tooltip="Number of labels">
              {metadata?.numCaptions || 0}
            </IconBadge>
            {(metadata?.numCaptions || 0) > 0 && (
              <IconBadge
                color={colorScheme === 'dark' ? 'gray.2' : 'gray.8'}
                icon={<IconCategory size={14} />}
                tooltip="Label type"
              >
                {metadata?.labelType ?? 'tag'}
              </IconBadge>
            )}
          </Group>
        ),
      },
      {
        label: 'Dataset',
        value: url ? (
          <Button
            component="a"
            target="_blank" // TODO we dont want this, but need it for useCatchNavigation
            href={createModelFileDownloadUrl({
              versionId,
              type: 'Training Data',
            })}
            color="cyan"
            size="compact-sm"
            leftSection={<IconDownload size={16} />}
          >
            <Text align="center">{`Download (${formatKBytes(sizeKB)})`}</Text>
          </Button>
        ) : (
          'None'
        ),
      },
      // TODO could get the name of the custom model
      {
        label: 'Base Model',
        value: isDefined(baseModel) ? (
          baseModel in trainingModelInfo ? (
            trainingModelInfo[baseModel as TrainingDetailsBaseModelList].pretty
          ) : isAir(baseModel) ? (
            <Text component="a" href={getAirModelLink(baseModel)} target="_blank" c="blue.4">
              <Group gap="xs">
                <Text>Custom</Text>
                <IconExternalLink size={14} />
              </Group>
            </Text>
          ) : (
            baseModel
          )
        ) : (
          '-'
        ),
      },
      {
        label: 'Training Params',
        value: params ? (
          <Accordion
            styles={(theme) => ({
              content: {
                padding: theme.spacing.xs,
              },
              item: {
                border: 'none',
                background: 'transparent',
              },
              control: {
                padding: `${theme.spacing.xs}px 0`,
              },
            })}
          >
            <Accordion.Item value="params">
              <Accordion.Control>
                <Text size="xs">Expand</Text>
              </Accordion.Control>
              <Accordion.Panel>
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                  {params.engine === 'rapid'
                    ? JSON.stringify({ engine: params.engine }, null, 2)
                    : JSON.stringify(params, null, 2)}
                </pre>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        ) : (
          'No training params set'
        ),
      },
    ];

    return (
      <TwCard
        className={isSelected ? 'shadow-[0_0_7px_3px] !shadow-blue-8' : 'shadow-[0_0_4px_1px]'}
      >
        <div className="flex h-full flex-col justify-between">
          {!selectable && (
            <Overlay
              blur={2}
              zIndex={11}
              color={colorScheme === 'dark' ? theme.colors.dark[7] : theme.white}
              opacity={0.8}
            />
          )}
          <div className="relative overflow-auto">
            <div className="size-full">
              <DescriptionTable
                // title="Dataset Details"
                items={modelDetails}
                labelWidth="80px"
                className="text-xs"
                withBorder
              />
            </div>
          </div>
          <div
            className="flex cursor-pointer flex-col gap-2 p-3 text-black dark:text-white"
            onClick={onChange}
          >
            <Group wrap="nowrap" justify="space-between">
              <Text size="sm" fw={700}>
                {img.modelVersion.model.name} ({img.modelVersion.name})
              </Text>
              <Button variant={isSelected ? 'light' : 'filled'} className="flex-none">
                {isSelected ? 'Deselect' : 'Select'}
              </Button>
            </Group>
          </div>
        </div>
      </TwCard>
    );
  }

  const safeParsedMeta = type === 'generation' ? imageMetaSchema.safeParse(img.step.params) : null;

  return (
    <div
      className={`relative cursor-pointer${
        isSelected ? ' shadow-[0_0_7px_3px] shadow-blue-8' : ''
      }`}
      onClick={onChange}
    >
      {!selectable && (
        <Overlay
          blur={2}
          zIndex={11}
          color={colorScheme === 'dark' ? theme.colors.dark[7] : theme.white}
          opacity={0.8}
        />
      )}
      <EdgeMedia
        alt={`Imported Media - ${img.id}`}
        src={img.url}
        type={img.type}
        width={DEFAULT_EDGE_IMAGE_WIDTH}
        className={`h-[250px] w-full object-cover`}
        anim={true}
      />

      <div className="absolute left-2 top-2">
        <Checkbox checked={isSelected} readOnly />
      </div>
      {type === 'generation' || !!img.meta ? (
        <div className="absolute bottom-2 right-2">
          <ImageMetaPopover
            meta={
              type === 'generation' && safeParsedMeta?.success
                ? safeParsedMeta.data
                : (img as UploadedImage).meta!
            }
            hideSoftware
          >
            <LegacyActionIcon variant="transparent" size="md">
              <IconInfoCircle
                color="white"
                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                opacity={0.8}
                strokeWidth={2.5}
                size={26}
              />
            </LegacyActionIcon>
          </ImageMetaPopover>
        </div>
      ) : undefined}
    </div>
  );
};
