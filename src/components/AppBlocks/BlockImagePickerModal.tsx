import {
  Alert,
  AspectRatio,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Stack,
  Tabs,
  Text,
  ThemeIcon,
  UnstyledButton,
} from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useSignInToUpload } from '~/components/Login/useSignInToUpload';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { trpc } from '~/utils/trpc';
import {
  isSamePick,
  MAX_EMPTY_AUTO_PAGES,
  projectGeneratedPick,
  projectPostedPick,
  togglePickedImage,
  type BlockImagePickerSource,
  type BlockPickedImageInfo,
} from './imagePickerLogic';

type PickableImage = {
  /** What the grid renders: a storage key (posted) or the output's own url (generated). */
  thumbnail: string;
  pick: BlockPickedImageInfo;
};

const SOURCE_LABEL: Record<BlockImagePickerSource, string> = {
  posted: 'Posted',
  generated: 'Generated',
};

const EMPTY_MESSAGE: Record<BlockImagePickerSource, string> = {
  posted: 'None of your posted images can be used here yet.',
  generated: 'None of your generated images can be used here yet.',
};

/**
 * Host modal behind PageBlockHost's `OPEN_IMAGE_PICKER`: the viewer picks from their own posted
 * and generated images. The app never sees the library, only what `onResolved` is given.
 */
export default function BlockImagePickerModal({
  sources,
  max,
  onResolved,
}: {
  sources: BlockImagePickerSource[];
  /** `null` for a single pick, otherwise the most images the viewer may select. */
  max: number | null;
  /** Called once, on confirm, before the modal closes. Not called on dismiss. */
  onResolved: (picked: BlockPickedImageInfo[]) => void;
}) {
  const dialog = useDialogContext();
  const { signedOut, requireSignIn } = useSignInToUpload();
  const [source, setSource] = useState<BlockImagePickerSource>(sources[0]);
  const [selected, setSelected] = useState<BlockPickedImageInfo[]>([]);

  // The viewer's own level with the domain cap applied: what the server reads for the posted tab.
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const utils = trpc.useUtils();
  const listedAtLevel = useRef(browsingLevel);
  useEffect(() => {
    if (listedAtLevel.current === browsingLevel) return;
    listedAtLevel.current = browsingLevel;
    // Everything listed or selected so far was allowed at the previous level.
    setSelected([]);
    void utils.blockImagePicker.getPosted.reset();
  }, [browsingLevel, utils]);

  const multiple = max !== null;
  const atMax = multiple && selected.length >= max;

  function toggle(image: BlockPickedImageInfo) {
    setSelected((current) => togglePickedImage(current, image, max));
  }

  function confirm() {
    onResolved(selected);
    dialog.onClose();
  }

  function signIn() {
    requireSignIn();
    dialog.onClose();
  }

  const title = multiple && max > 1 ? `Choose up to ${max} images` : 'Choose an image';
  const grid = { selected, atMax, onToggle: toggle, browsingLevel };

  return (
    <Modal {...dialog} withCloseButton size={800} title={title}>
      {signedOut ? (
        <Stack gap="md" align="flex-start">
          <Text size="sm">Sign in to choose from your images.</Text>
          <Button onClick={signIn}>Sign in</Button>
        </Stack>
      ) : (
        <Stack gap="md">
          <Text size="xs" c="dimmed">
            Your images that your content settings allow and that have finished scanning.
          </Text>

          {sources.length > 1 ? (
            <Tabs
              value={source}
              onChange={(value) => value && setSource(value as BlockImagePickerSource)}
              keepMounted={false}
            >
              <Tabs.List mb="sm">
                {sources.map((s) => (
                  <Tabs.Tab key={s} value={s}>
                    {SOURCE_LABEL[s]}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              {sources.map((s) => (
                <Tabs.Panel key={s} value={s}>
                  <SourceGrid source={s} {...grid} />
                </Tabs.Panel>
              ))}
            </Tabs>
          ) : (
            <SourceGrid source={source} {...grid} />
          )}

          <Group justify="space-between">
            <Text size="sm" c="dimmed" data-testid="block-image-picker-count">
              {multiple ? `${selected.length} of ${max} selected` : ''}
            </Text>
            <Group gap="xs">
              <Button variant="default" onClick={dialog.onClose}>
                Cancel
              </Button>
              <Button onClick={confirm} disabled={selected.length === 0}>
                {selected.length > 1 ? `Use ${selected.length} images` : 'Use image'}
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

type GridSelection = {
  browsingLevel: number;
  selected: BlockPickedImageInfo[];
  atMax: boolean;
  onToggle: (image: BlockPickedImageInfo) => void;
};

function SourceGrid({ source, ...selection }: GridSelection & { source: BlockImagePickerSource }) {
  return source === 'posted' ? <PostedGrid {...selection} /> : <GeneratedGrid {...selection} />;
}

function PostedGrid(selection: GridSelection) {
  const { data, isLoading, isError, isFetching, hasNextPage, fetchNextPage, refetch } =
    trpc.blockImagePicker.getPosted.useInfiniteQuery(
      {},
      {
        getNextPageParam: (lastPage) => lastPage.nextCursor,
        // The server filters by the viewer's browsing level, which is not part of the query key.
        // The app caches queries forever by default, so without these a reopened picker would list
        // what an earlier level allowed.
        gcTime: 0,
        staleTime: 0,
      }
    );

  const images = useMemo(
    () =>
      (data?.pages ?? []).flatMap((page) =>
        page.items.flatMap((item): PickableImage[] => {
          const pick = projectPostedPick(item);
          return pick ? [{ thumbnail: item.key, pick }] : [];
        })
      ),
    [data]
  );

  return (
    <PickGrid
      source="posted"
      images={images}
      loading={isLoading}
      failed={isError}
      fetching={isFetching}
      hasMore={!!hasNextPage}
      onLoadMore={fetchNextPage}
      onRetry={data ? fetchNextPage : refetch}
      {...selection}
    />
  );
}

function GeneratedGrid(selection: GridSelection) {
  const { browsingLevel } = selection;
  const { data, isFetching, isFetchingNextPage, isError, hasNextPage, fetchNextPage, refetch } =
    useGetTextToImageRequests(
      { tags: [WORKFLOW_TAGS.IMAGE] },
      { enabled: true, ignoreFilters: true }
    );

  const images = useMemo(
    () =>
      data.flatMap((workflow) =>
        workflow.succeededOutput.flatMap((output): PickableImage[] => {
          const pick = projectGeneratedPick(output, browsingLevel);
          return pick ? [{ thumbnail: output.url, pick }] : [];
        })
      ),
    [data, browsingLevel]
  );

  return (
    <PickGrid
      source="generated"
      images={images}
      loading={isFetching && !isFetchingNextPage && data.length === 0}
      failed={isError}
      fetching={isFetching}
      hasMore={!!hasNextPage}
      onLoadMore={fetchNextPage}
      onRetry={data.length > 0 ? fetchNextPage : refetch}
      {...selection}
    />
  );
}

function PickGrid({
  source,
  images,
  loading,
  failed,
  fetching,
  hasMore,
  onLoadMore,
  onRetry,
  selected,
  atMax,
  onToggle,
}: GridSelection & {
  source: BlockImagePickerSource;
  images: PickableImage[];
  loading: boolean;
  failed: boolean;
  fetching: boolean;
  /** More pages exist. A page can hold nothing pickable, so an empty grid is not the end. */
  hasMore: boolean;
  onLoadMore: () => unknown;
  onRetry: () => unknown;
}) {
  // Pages in a row that added nothing pickable. An app can open this modal without a gesture, so
  // loading the next page automatically has to stop somewhere for a library with nothing to offer.
  const [emptyStreak, setEmptyStreak] = useState(0);
  const [load, setLoad] = useState<{ before: number; settled: boolean } | null>(null);

  async function fetchPage(fetch: () => unknown) {
    if (load) return;
    setLoad({ before: images.length, settled: false });
    try {
      await fetch();
    } finally {
      setLoad((current) => (current ? { ...current, settled: true } : current));
    }
  }

  // Judged once the fetch has settled AND the query has reported it, so the page's own images are
  // counted before it is called empty. A page that failed is neither: it told us nothing.
  useEffect(() => {
    if (!load?.settled || fetching) return;
    if (images.length > load.before) setEmptyStreak(0);
    else if (!failed) setEmptyStreak((streak) => streak + 1);
    setLoad(null);
  }, [load, fetching, failed, images.length]);

  if (loading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  if (images.length === 0 && !hasMore && !failed) {
    return (
      <Text size="sm" c="dimmed" py="xl" ta="center">
        {EMPTY_MESSAGE[source]}
      </Text>
    );
  }

  const autoLoad = hasMore && !failed && emptyStreak < MAX_EMPTY_AUTO_PAGES;

  return (
    <Box mah={440} style={{ overflowY: 'auto' }}>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 p-1">
        {images.map(({ thumbnail, pick }, index) => {
          const isSelected = selected.some((s) => isSamePick(s, pick));
          const disabled = atMax && !isSelected;
          return (
            <UnstyledButton
              key={pick.url}
              aria-label={`${SOURCE_LABEL[source]} image ${index + 1}`}
              aria-pressed={isSelected}
              disabled={disabled}
              onClick={() => onToggle(pick)}
              className={clsx(
                'relative overflow-hidden rounded-md',
                isSelected && 'ring-2 ring-blue-5',
                disabled && 'cursor-not-allowed opacity-40'
              )}
            >
              <AspectRatio ratio={1}>
                <EdgeMedia
                  alt=""
                  src={thumbnail}
                  type="image"
                  width={450}
                  className="size-full object-cover"
                />
              </AspectRatio>
              {isSelected && (
                <ThemeIcon size="sm" radius="xl" className="absolute right-1.5 top-1.5">
                  <IconCheck size={14} />
                </ThemeIcon>
              )}
            </UnstyledButton>
          );
        })}
      </div>
      {failed ? (
        <Alert color="red" variant="light" mt="sm">
          <Group justify="space-between" gap="xs">
            <Text size="sm">Couldn&apos;t load your images.</Text>
            <Button
              size="xs"
              variant="default"
              onClick={() => fetchPage(onRetry)}
              loading={fetching || !!load}
            >
              Retry
            </Button>
          </Group>
        </Alert>
      ) : autoLoad ? (
        <InViewLoader loadFn={() => fetchPage(onLoadMore)} loadCondition={!fetching && !load}>
          <Center p="md">
            <Loader size="sm" />
          </Center>
        </InViewLoader>
      ) : hasMore ? (
        <Stack gap="xs" align="center" p="md">
          <Text size="sm" c="dimmed">
            No usable images found in the most recent pages.
          </Text>
          <Button
            size="xs"
            variant="default"
            onClick={() => fetchPage(onLoadMore)}
            loading={fetching || !!load}
          >
            Load more
          </Button>
        </Stack>
      ) : null}
    </Box>
  );
}
