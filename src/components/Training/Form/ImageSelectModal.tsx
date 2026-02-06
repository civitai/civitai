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
import React, { createContext, useContext, useMemo, useState } from 'react';
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
import type { TextToImageSteps } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
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
import type { NormalizedGeneratedImage } from '~/server/services/orchestrator';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { MediaType, TrainingStatus } from '~/shared/utils/prisma/enums';
import type { ImageGetMyInfinite, RecentTrainingData } from '~/types/router';
import { formatDate } from '~/utils/date-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { getAirModelLink, isAir, splitUppercase } from '~/utils/string-helpers';
import { trainingModelInfo } from '~/utils/training';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import styles from '~/components/Search/SearchLayout.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

// const take = 20;

export type SelectedImage = {
  url: string;
  label: string;
  type: MediaType;
  meta?: Record<string, unknown>;
};

type GennedMedia = NormalizedGeneratedImage & {
  params: TextToImageSteps[number]['params'];
  resources: TextToImageSteps[number]['resources'];
  completed?: Date;
};
type UploadedImage = Omit<ImageGetMyInfinite[number], 'meta'> & { meta: ImageMetaProps | null };
type TrainedData = Omit<RecentTrainingData[number], 'metadata' | 'modelVersion'> & {
  metadata: FileMetadata | null;
  modelVersion: Omit<RecentTrainingData[number]['modelVersion'], 'trainingDetails'> & {
    trainingDetails: TrainingDetailsObj | null;
  };
};

const ImageSelectContext = createContext<{
  selected: SelectedImage[];
  setSelected: React.Dispatch<React.SetStateAction<SelectedImage[]>>;
  importedUrls: string[];
} | null>(null);

const useImageSelectContext = () => {
  const context = useContext(ImageSelectContext);
  if (!context) throw new Error('missing ImageSelectContext');
  return context;
};

export type ImageSelectModalProps = {
  title?: React.ReactNode;
  onSelect: (data: SelectedImage[]) => void;
  importedUrls: string[];
  videoAllowed: boolean;
  selectSource?: ImageSelectSource;
};

export default function ImageSelectModal({
  title,
  onSelect,
  importedUrls,
  videoAllowed,
  selectSource = 'generation',
}: ImageSelectModalProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();

  const [selected, setSelected] = useState<SelectedImage[]>([]);
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
    steps,
    isFetching: isLoadingGenerations,
    isFetchingNextPage: isFetchingNextPageGenerations,
    hasNextPage: hasNextPageGenerations,
    fetchNextPage: fetchNextPageGenerations,
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
      steps.flatMap((step) =>
        step.images
          .filter((x) => x.status === 'succeeded' && x.available && !x.blockedReason)
          .map((asset) => {
            if (!asset.available || asset.status !== 'succeeded') return null;
            return {
              ...asset,
              params: {
                ...step.params,
                seed: asset.seed ?? undefined,
                completed: step.completedAt ? new Date(step.completedAt) : undefined,
                stepName: step.name,
              },
              resources: step.resources,
            };
          })
          .filter(isDefined)
      ),
    [steps]
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
    onSelect(selected);
    dialog.onClose();
  }

  function handleClose() {
    dialog.onClose();
  }

  return (
    <Modal {...dialog} onClose={handleClose} size={1200} withCloseButton={false} padding={0}>
      <ImageSelectContext.Provider value={{ selected, setSelected, importedUrls }}>
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
                <Button onClick={handleSelect} disabled={!selected.length}>{`Import${
                  selected.length > 0 ? ` (${selected.length})` : ''
                }`}</Button>
                <Button variant="light" onClick={() => setSelected([])} disabled={!selected.length}>
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
              {selectSource === 'generation' ? (
                <ImageGrid data={generatedMedia} type={selectSource} />
              ) : selectSource === 'uploaded' ? (
                <ImageGrid data={uploadedMedia} type={selectSource} />
              ) : selectSource === 'training' ? (
                <ImageGrid data={trainingFiles} type={selectSource} />
              ) : (
                <></>
              )}
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
      </ImageSelectContext.Provider>
    </Modal>
  );
}

const ImageGrid = ({
  type,
  data,
}:
  | { type: 'generation'; data: GennedMedia[] }
  | { type: 'uploaded'; data: UploadedImage[] }
  | { type: 'training'; data: TrainedData[] }) => {
  if (!data || !data.length)
    return <NoContent message={`No ${type === 'training' ? 'datasets' : 'assets'} found`} />;

  const grouped =
    type === 'generation'
      ? // ? groupBy(data, ({ workflowId }) => workflowId)
        groupBy(data, ({ completed }) =>
          !!completed
            ? completed.toLocaleString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })
            : 'Unknown Date'
        )
      : type === 'uploaded'
      ? groupBy(data, ({ createdAt }) =>
          !!createdAt
            ? createdAt.toLocaleString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })
            : 'Unknown Date'
        )
      : groupBy(data, ({ createdAt }) =>
          !!createdAt
            ? createdAt.toLocaleString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })
            : 'Unknown Date'
        );

  return (
    <Stack>
      {Object.entries(grouped).map(([date, imgs], index) => (
        <Stack key={index}>
          <Title order={4} className="mb-2">
            {/*{type === 'generation'*/}
            {/*  ? formatDate(*/}
            {/*      new Date(*/}
            {/*        Math.max(*/}
            {/*          ...imgs*/}
            {/*            .map((i: GennedMedia) =>*/}
            {/*              i.completed ? new Date(i.completed).getTime() : null*/}
            {/*            )*/}
            {/*            .filter(isDefined)*/}
            {/*        )*/}
            {/*      ),*/}
            {/*      'MMM D, YYYY h:mm:ss A'*/}
            {/*    )*/}
            {/*  : date}*/}
            {date}
          </Title>
          <div
            className={clsx('p-2', styles.grid)}
            style={
              type === 'training'
                ? { gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }
                : {}
            }
          >
            {type === 'generation'
              ? imgs.map((img: GennedMedia) => (
                  <ImageGridMedia
                    key={`${img.workflowId}_${img.stepName}_${img.id}`}
                    type={type}
                    img={img}
                  />
                ))
              : type === 'uploaded'
              ? imgs.map((img: UploadedImage) => (
                  <ImageGridMedia key={img.id} type={type} img={img} />
                ))
              : imgs.map((img: TrainedData) => (
                  <ImageGridMedia key={img.id} type={type} img={img} />
                ))}
          </div>
        </Stack>
      ))}
    </Stack>
  );
};

const ImageGridMedia = ({
  type,
  img,
}:
  | { type: 'generation'; img: GennedMedia }
  | { type: 'uploaded'; img: UploadedImage }
  | { type: 'training'; img: TrainedData }) => {
  const { selected, setSelected, importedUrls } = useImageSelectContext();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');

  const compareKey = type === 'training' ? `${img.modelVersion.id}` : img.url;

  const selectable = !importedUrls.includes(compareKey);
  const isSelected = selected.map((s) => s.url).includes(compareKey);

  const onChange = () => {
    if (!selectable) return;
    setSelected((prev) => {
      if (!isSelected) {
        // Build meta for generation images using getStepMeta pattern
        let meta: Record<string, unknown> | undefined;
        if (type === 'generation') {
          meta = getStepMeta({
            params: img.params,
            resources: img.resources,
            metadata: {},
          } as any);
        } else if (type === 'uploaded' && img.meta) {
          meta = img.meta as Record<string, unknown>;
        }

        return [
          ...prev,
          {
            url: compareKey,
            label:
              type === 'generation' && 'prompt' in img.params
                ? (img.params.prompt as string)
                : type === 'uploaded'
                ? img.meta?.prompt ?? ''
                : '',
            type: type === 'training' ? 'image' : img.type,
            meta,
          },
        ];
      } else {
        return prev.filter((x) => x.url !== compareKey);
      }
    });
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

  const safeParsedMeta =
    type === 'generation' ? imageMetaSchema.safeParse(img.params) : null;

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
        className={`h-[250px] w-full object-cover`}
        anim={true}
      />

      <div className="absolute left-2 top-2">
        <Checkbox checked={isSelected} readOnly />
      </div>
      {type === 'generation' || !!img.meta ? (
        <div className="absolute bottom-2 right-2">
          <ImageMetaPopover
            meta={type === 'generation' && safeParsedMeta?.success ? safeParsedMeta.data : (img as UploadedImage).meta!}
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
