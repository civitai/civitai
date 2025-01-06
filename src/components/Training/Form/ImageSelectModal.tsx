import {
  ActionIcon,
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
  useMantineTheme,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import type { FetchNextPageOptions } from '@tanstack/react-query';
import { groupBy } from 'lodash-es';
import React, { createContext, useContext, useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageSelectSource } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { MarkerFiltersDropdown } from '~/components/ImageGeneration/MarkerFiltersDropdown';
import {
  TextToImageSteps,
  useGetTextToImageRequests,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { ImageMetaPopover } from '~/components/ImageMeta/ImageMeta';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import { useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { GeneratedImage } from '~/server/services/orchestrator';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { ImageGetMyInfinite } from '~/types/router';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

// const take = 20;

export type SelectedImage = {
  url: string;
  label: string;
};

type GennedImage = GeneratedImage & { params: TextToImageSteps[number]['params'] };
type UploadedImage = Omit<ImageGetMyInfinite[number], 'meta'> & { meta: ImageMetaProps | null };

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
  onSelect: (images: SelectedImage[]) => void;
  importedUrls: string[];
  selectSource?: ImageSelectSource;
};

export default function ImageSelectModal({
  title,
  onSelect,
  importedUrls,
  selectSource = 'generation',
}: ImageSelectModalProps) {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const isMobile = useIsMobile();

  const [selected, setSelected] = useState<SelectedImage[]>([]);
  // const [selectFilters, setSelectFilters] = useState<ResourceFilter>({ types: [], baseModels: [] });

  const {
    steps,
    isFetching: isLoadingGenerations,
    isFetchingNextPage: isFetchingNextPageGenerations,
    hasNextPage: hasNextPageGenerations,
    fetchNextPage: fetchNextPageGenerations,
    // isError: isErrorGenerations,
  } = useGetTextToImageRequests(
    { tags: [WORKFLOW_TAGS.IMAGE] },
    { enabled: !!currentUser && selectSource === 'generation' }
  );

  const {
    data: dataUploaded,
    isFetching: isLoadingUploaded,
    isFetchingNextPage: isFetchingNextPageUploaded,
    hasNextPage: hasNextPageUploaded,
    fetchNextPage: fetchNextPageUploaded,
    // isError: isErrorUploaded,
  } = trpc.image.getMyImages.useInfiniteQuery(
    {},
    {
      enabled: !!currentUser && selectSource === 'uploaded',
      getNextPageParam: (lastPage) => lastPage.nextCursor,
    }
  );

  const generatedImages = useMemo(
    () =>
      steps.flatMap((step) =>
        step.images
          .filter((x) => x.status === 'succeeded' && x.type === 'image' && !!x.completed)
          .map((image) => {
            if (image.type !== 'image' || !image.completed || image.status !== 'succeeded')
              return null;
            return { ...image, params: { ...step.params, seed: image.seed } };
          })
          .filter(isDefined)
      ),
    [steps]
  );

  const uploadedImages = useMemo(
    () =>
      (dataUploaded?.pages.flatMap((x) => (!!x ? x.items : [])) ?? []).map((d) => ({
        ...d,
        meta: d.meta as ImageMetaProps | null,
      })),
    [dataUploaded]
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
    isLoading = false;
    isFetchingNext = false;
    hasNextPage = false;
    fetchNextPage = async () => null;
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

            {/*<div className="flex flex-col gap-3 sm:flex-row sm:flex-nowrap sm:items-center sm:justify-between sm:gap-10">*/}
            {/*    <ResourceSelectSort />*/}
            {/*    <ResourceSelectFiltersDropdown*/}
            {/*      options={options}*/}
            {/*      selectFilters={selectFilters}*/}
            {/*      setSelectFilters={setSelectFilters}*/}
            {/*    />*/}
            {/*</div>*/}

            <Group position="apart">
              <Group>
                <Button onClick={handleSelect} disabled={!selected.length}>{`Select${
                  selected.length > 0 ? ` (${selected.length})` : ''
                }`}</Button>
                <Button variant="light" onClick={() => setSelected([])} disabled={!selected.length}>
                  Deselect All
                </Button>
              </Group>
              {selectSource === 'generation' && (
                <MarkerFiltersDropdown text="Filters" position="bottom-end" />
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
                <ImageGrid data={generatedImages} type={selectSource} />
              ) : selectSource === 'uploaded' ? (
                <ImageGrid data={uploadedImages} type={selectSource} />
              ) : (
                <></>
              )}
              {hasNextPage && (
                <InViewLoader
                  loadFn={fetchNextPage}
                  loadCondition={!isLoading && !isFetchingNext && hasNextPage}
                >
                  <Center p="xl" sx={{ height: 36 }} mt="md">
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
}: { type: 'generation'; data: GennedImage[] } | { type: 'uploaded'; data: UploadedImage[] }) => {
  const { classes, cx } = useSearchLayoutStyles();

  if (!data || !data.length) return <NoContent message="No images found" />;

  const grouped =
    type === 'generation'
      ? groupBy(data, ({ completed }) =>
          !!completed
            ? completed.toLocaleString(undefined, { month: 'short', year: 'numeric' })
            : 'Unknown'
        )
      : groupBy(data, ({ createdAt }) =>
          !!createdAt
            ? createdAt.toLocaleString(undefined, { month: 'short', year: 'numeric' })
            : 'Unknown'
        );

  // TODO does grouping work with infinite?

  return (
    <Stack>
      {Object.entries(grouped).map(([date, imgs], index) => (
        <Stack key={index}>
          <Title order={4} className="mb-2">
            {date}
          </Title>
          <div className={cx('p-2', classes.grid)}>
            {type === 'generation'
              ? imgs.map((img: GennedImage) => (
                  <ImageGridImage
                    key={`${img.workflowId}_${img.stepName}_${img.id}`}
                    type={type}
                    img={img}
                  />
                ))
              : imgs.map((img: UploadedImage) => (
                  <ImageGridImage key={img.id} type={type} img={img} />
                ))}
          </div>
        </Stack>
      ))}
    </Stack>
  );
};

const ImageGridImage = ({
  type,
  img,
}: { type: 'generation'; img: GennedImage } | { type: 'uploaded'; img: UploadedImage }) => {
  const { selected, setSelected, importedUrls } = useImageSelectContext();
  const theme = useMantineTheme();

  const selectable = !importedUrls.includes(img.url);
  const isSelected = selected.map((s) => s.url).includes(img.url);

  const onChange = () => {
    if (!selectable) return;
    setSelected((prev) => {
      if (!isSelected) {
        return [
          ...prev,
          {
            url: img.url,
            label: type === 'generation' ? img.params.prompt : img.meta?.prompt ?? '',
          },
        ];
      } else {
        return prev.filter((x) => x.url !== img.url);
      }
    });
  };

  return (
    <div className="relative">
      {!selectable && (
        <Overlay
          blur={2}
          // zIndex={10}
          color={theme.colorScheme === 'dark' ? theme.colors.dark[7] : '#fff'}
          opacity={0.8}
        />
      )}
      <EdgeMedia
        alt={`Imported Image - ${img.id}`}
        src={img.url}
        className={`cursor-pointer${isSelected ? ' shadow-[0_0_7px_3px] shadow-blue-8' : ''}`}
        style={{
          height: '250px',
          width: '100%',
          // if we want to show full image, change objectFit to contain
          objectFit: 'cover',
          // object-position: top;
        }}
        onClick={onChange}
      />

      <div className="absolute left-2 top-2">
        <Checkbox checked={isSelected} onChange={onChange} />
      </div>
      {type === 'generation' || !!img.meta ? (
        <div className="absolute bottom-2 right-2">
          <ImageMetaPopover meta={type === 'generation' ? img.params : img.meta!} hideSoftware>
            <ActionIcon variant="transparent" size="md">
              <IconInfoCircle
                color="white"
                filter="drop-shadow(1px 1px 2px rgb(0 0 0 / 50%)) drop-shadow(0px 5px 15px rgb(0 0 0 / 60%))"
                opacity={0.8}
                strokeWidth={2.5}
                size={26}
              />
            </ActionIcon>
          </ImageMetaPopover>
        </div>
      ) : undefined}
    </div>
  );
};
