import {
  ActionIcon,
  Button,
  Center,
  Checkbox,
  CloseButton,
  Divider,
  Group,
  Image as MImage,
  Loader,
  Modal,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { groupBy } from 'lodash-es';
import React, { createContext, useContext, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
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
import { GeneratedImage } from '~/server/services/orchestrator';
import { isDefined } from '~/utils/type-guards';

// const take = 20;

const ImageSelectContext = createContext<{
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
} | null>(null);

const useImageSelectContext = () => {
  const context = useContext(ImageSelectContext);
  if (!context) throw new Error('missing ImageSelectContext');
  return context;
};

export type ImageSelectModalProps = {
  title?: React.ReactNode;
  onSelect: (images: string[]) => void;
  selectSource?: ImageSelectSource;
};

export default function ImageSelectModal({
  title,
  onSelect,
  selectSource = 'generation',
}: ImageSelectModalProps) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile();
  const currentUser = useCurrentUser();
  const { classes, theme } = useSearchLayoutStyles();

  const [selected, setSelected] = useState<string[]>([]);
  // const [selectFilters, setSelectFilters] = useState<ResourceFilter>({ types: [], baseModels: [] });

  const {
    steps,
    isFetching: isLoadingGenerations,
    isFetchingNextPage: isFetchingNextPageGenerations,
    hasNextPage: hasNextPageGenerations,
    fetchNextPage: fetchNextPageGenerations,
    // isError: isErrorGenerations,
  } = useGetTextToImageRequests(
    // { take },
    undefined,
    { enabled: !!currentUser && selectSource === 'generation' }
  );

  const isLoading = isLoadingGenerations;
  const isFetchingNext = isFetchingNextPageGenerations;
  const hasNextPage = hasNextPageGenerations;
  const fetchNextPage = fetchNextPageGenerations;

  function handleSelect() {
    onSelect(selected);
    dialog.onClose();
  }

  function handleClose() {
    dialog.onClose();
  }

  return (
    <Modal {...dialog} onClose={handleClose} size={1200} withCloseButton={false} padding={0}>
      <ImageSelectContext.Provider value={{ selected, setSelected }}>
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
              <Button onClick={handleSelect}>{`Select${
                selected.length > 0 && ` (${selected.length})`
              }`}</Button>
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
              {selectSource === 'generation' && <ImageGridGeneration data={steps} />}
              {hasNextPage && (
                <InViewLoader loadFn={fetchNextPage} loadCondition={!isLoading && hasNextPage}>
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

const ImageGridGeneration = ({ data }: { data: TextToImageSteps }) => {
  const { classes, theme } = useSearchLayoutStyles();

  const images = data.flatMap((step) =>
    step.images
      .filter((x) => x.status === 'succeeded' && x.type === 'image' && !!x.completed)
      .map((image) => {
        if (image.type !== 'image' || !image.completed || image.status !== 'succeeded') return null;
        return { ...image, params: { ...step.params, seed: image.seed } };
      })
      .filter(isDefined)
  );

  if (!images || !images.length) return <NoContent message="No images found" />;

  const grouped = groupBy(images, ({ completed }) =>
    !!completed
      ? completed.toLocaleString(undefined, { month: 'short', year: 'numeric' })
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
          <div className={classes.grid}>
            {imgs.map((img) => (
              <ImageGridGenerationImage key={img.id} img={img} />
            ))}
          </div>
        </Stack>
      ))}
    </Stack>
  );
};

const ImageGridGenerationImage = ({
  img,
}: {
  img: GeneratedImage & { params: TextToImageSteps[number]['params'] };
}) => {
  const { selected, setSelected } = useImageSelectContext();

  return (
    <div className="relative">
      <MImage
        alt={`Generated Image - ${img.id}`}
        src={img.url}
        imageProps={{
          style: {
            height: '250px',
            width: '100%',
            // if we want to show full image, change objectFit to contain
            objectFit: 'cover',
            // object-position: top;
          },
        }}
      />

      <div className="absolute left-2 top-2">
        <Checkbox
          checked={selected.includes(img.url)}
          onChange={(e) => {
            setSelected((prev) => {
              if (e.currentTarget.checked) {
                return [...prev, img.url];
              } else {
                return prev.filter((x) => x !== img.url);
              }
            });
          }}
        />
      </div>
      <div className="absolute bottom-2 right-2">
        <ImageMetaPopover
          meta={img.params}
          // zIndex={10}
          hideSoftware
        >
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
    </div>
  );
};
