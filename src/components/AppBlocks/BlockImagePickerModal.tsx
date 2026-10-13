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
import { useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useSignInToUpload } from '~/components/Login/useSignInToUpload';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { trpc } from '~/utils/trpc';
import {
  isSamePick,
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
  const grid = { selected, atMax, onToggle: toggle };

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
            Only safe-for-work images that have finished scanning are listed.
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
  selected: BlockPickedImageInfo[];
  atMax: boolean;
  onToggle: (image: BlockPickedImageInfo) => void;
};

function SourceGrid({ source, ...selection }: GridSelection & { source: BlockImagePickerSource }) {
  return source === 'posted' ? <PostedGrid {...selection} /> : <GeneratedGrid {...selection} />;
}

function PostedGrid(selection: GridSelection) {
  const { data, isLoading, isError, isFetching, hasNextPage, fetchNextPage } =
    trpc.blockImagePicker.getPosted.useInfiniteQuery(
      {},
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
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
      canLoadMore={!!hasNextPage && !isFetching}
      hasMore={!!hasNextPage}
      onLoadMore={fetchNextPage}
      {...selection}
    />
  );
}

function GeneratedGrid(selection: GridSelection) {
  const { data, isFetching, isFetchingNextPage, isError, hasNextPage, fetchNextPage } =
    useGetTextToImageRequests(
      { tags: [WORKFLOW_TAGS.IMAGE] },
      { enabled: true, ignoreFilters: true }
    );

  const images = useMemo(
    () =>
      data.flatMap((workflow) =>
        workflow.succeededOutput.flatMap((output): PickableImage[] => {
          const pick = projectGeneratedPick(output);
          return pick ? [{ thumbnail: output.url, pick }] : [];
        })
      ),
    [data]
  );

  return (
    <PickGrid
      source="generated"
      images={images}
      loading={isFetching && !isFetchingNextPage && images.length === 0}
      failed={isError}
      canLoadMore={!!hasNextPage && !isFetching}
      hasMore={!!hasNextPage}
      onLoadMore={fetchNextPage}
      {...selection}
    />
  );
}

function PickGrid({
  source,
  images,
  loading,
  failed,
  canLoadMore,
  hasMore,
  onLoadMore,
  selected,
  atMax,
  onToggle,
}: GridSelection & {
  source: BlockImagePickerSource;
  images: PickableImage[];
  loading: boolean;
  failed: boolean;
  canLoadMore: boolean;
  /** More pages exist. A page can hold nothing pickable, so an empty grid is not the end. */
  hasMore: boolean;
  onLoadMore: () => unknown;
}) {
  if (loading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  if (failed && images.length === 0) {
    return (
      <Alert color="red" variant="light">
        Couldn&apos;t load your images. Close this and try again.
      </Alert>
    );
  }

  if (images.length === 0 && !hasMore) {
    return (
      <Text size="sm" c="dimmed" py="xl" ta="center">
        {EMPTY_MESSAGE[source]}
      </Text>
    );
  }

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
      {hasMore && (
        <InViewLoader loadFn={onLoadMore} loadCondition={canLoadMore}>
          <Center p="md">
            <Loader size="sm" />
          </Center>
        </InViewLoader>
      )}
    </Box>
  );
}
