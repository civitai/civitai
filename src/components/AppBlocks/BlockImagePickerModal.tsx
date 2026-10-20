import {
  Alert,
  Box,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Stack,
  Tabs,
  Text,
  TextInput,
  ThemeIcon,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { LoadMoreButton } from '~/components/LoadMoreButton/LoadMoreButton';
import { IconCheck, IconX } from '@tabler/icons-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useSignInToUpload } from '~/components/Login/useSignInToUpload';
import { useIsMobile } from '~/hooks/useIsMobile';
import { PICKER_JUMP_MIN_DATE } from '~/server/schema/blocks/block-image-picker.schema';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { formatDateNullable } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import {
  isSamePick,
  jumpDateToBound,
  MAX_EMPTY_AUTO_PAGES,
  PICKER_TILE_GAP_PX,
  PICKER_JUMP_DEBOUNCE_MS,
  pickerGridLayout,
  projectGeneratedPick,
  projectPostedPick,
  removePickedImage,
  shouldDropPostedPicks,
  toDateInputValue,
  togglePickedImage,
  type BlockImagePickerSource,
  type BlockPickedImageInfo,
} from './imagePickerLogic';

type PickableImage = {
  /** What the grid renders: a storage key (posted) or the output's own url (generated). */
  thumbnail: string;
  /** Day posted or generated. */
  dateLabel?: string;
  pick: BlockPickedImageInfo;
};

/** A pick plus what the selected tray needs to draw it. The extra fields never reach `onResolved`. */
type SelectedImage = BlockPickedImageInfo & { thumbnail: string };

const SOURCE_LABEL: Record<BlockImagePickerSource, string> = {
  posted: 'Posted',
  generated: 'Generated',
};

const EMPTY_MESSAGE: Record<BlockImagePickerSource, string> = {
  posted: 'None of your posted images can be used here yet.',
  generated: 'None of your generated images can be used here yet.',
};

/** Space the grid keeps around its tiles, so a selected tile's ring is not clipped. */
const GRID_INSET_PX = 4;
const TRAY_THUMB_PX = 48;
/**
 * Width every thumbnail (grid and tray) is requested at. A width taken from the tile can land a
 * narrow phone on the 96 rung, which has no 2x variant (next rung 320), so a dense screen gets a
 * blurry image. One width also lets the tray reuse the grid's image.
 */
const THUMB_WIDTH = 320;

/**
 * Host modal behind PageBlockHost's `OPEN_IMAGE_PICKER`: the viewer picks from their own posted
 * and generated images. The app never sees the library, only what `onResolved` is given.
 *
 * Laid out as a fixed-height column — header, grid, footer — so the grid is the only thing that
 * scrolls and the footer's confirm button is always on screen. Full screen on a phone-width
 * viewport: the modal is portalled to `document.body`, so the viewport is the box that matters
 * (the same call `ReviewListingModal` makes), not `useIsMobile`'s container default.
 */
export default function BlockImagePickerModal({
  sources,
  max,
  publicOnly = false,
  onResolved,
}: {
  sources: BlockImagePickerSource[];
  /** `null` for a single pick, otherwise the most images the viewer may select. */
  max: number | null;
  /** Posted images only from posts that are not Private: the app asked for `publicOnly`. */
  publicOnly?: boolean;
  /** Called once, on confirm, before the modal closes. Not called on dismiss. */
  onResolved: (picked: BlockPickedImageInfo[]) => void;
}) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile({ type: 'media' });
  const { signedOut, requireSignIn } = useSignInToUpload();
  const [source, setSource] = useState<BlockImagePickerSource>(sources[0]);
  const [selected, setSelected] = useState<SelectedImage[]>([]);
  // Per source, the day the viewer jumped to (`YYYY-MM-DD`), kept while they switch tabs.
  const [jumpTo, setJumpTo] = useState<Record<BlockImagePickerSource, string>>({
    posted: '',
    generated: '',
  });

  // The viewer's own level with the domain cap applied: what the server reads for the posted tab.
  const browsingLevel = useViewerBrowsingLevelDebounced();
  const utils = trpc.useUtils();
  const listedAtLevel = useRef(browsingLevel);
  useEffect(() => {
    if (listedAtLevel.current === browsingLevel) return;
    listedAtLevel.current = browsingLevel;
    // Everything listed or selected so far was allowed at the previous level. The server may not
    // know the new level yet (the setting is saved after a delay), so this clears the list at once
    // and `BrowserSettingsProvider` resets it again when the save has landed.
    setSelected([]);
    void utils.blockImagePicker.getPosted.reset();
  }, [browsingLevel, utils]);

  const dropPostedPicks = useCallback(
    () =>
      setSelected((current) =>
        current.some((pick) => pick.source === 'posted')
          ? current.filter((pick) => pick.source !== 'posted')
          : current
      ),
    []
  );

  const multiple = max !== null;
  const atMax = multiple && selected.length >= max;

  // Stable, so a memoised tile is not re-rendered by every render of the modal.
  const toggle = useCallback(
    (image: PickableImage) =>
      setSelected((current) =>
        togglePickedImage(current, { ...image.pick, thumbnail: image.thumbnail }, max)
      ),
    [max]
  );

  function remove(image: SelectedImage) {
    setSelected((current) => removePickedImage(current, image));
  }

  function confirm() {
    onResolved(selected.map(({ thumbnail: _thumbnail, ...pick }) => pick));
    dialog.onClose();
  }

  function signIn() {
    requireSignIn();
    dialog.onClose();
  }

  const title = multiple && max > 1 ? `Choose up to ${max} images` : 'Choose an image';
  const gridFor = (s: BlockImagePickerSource) => ({
    selected,
    atMax,
    onToggle: toggle,
    browsingLevel,
    dropPostedPicks,
    publicOnly,
    jumpTo: jumpTo[s],
    onJumpTo: (value: string) => setJumpTo((current) => ({ ...current, [s]: value })),
  });

  // Signed-out content is two lines: it keeps Mantine's own sizing.
  const columnStyles = signedOut
    ? undefined
    : {
        content: {
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          height: isMobile ? '100dvh' : 'min(760px, calc(100dvh - 2 * var(--modal-y-offset)))',
        } satisfies CSSProperties,
        header: { flexShrink: 0 } satisfies CSSProperties,
        body: {
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
          minHeight: 0,
        } satisfies CSSProperties,
      };

  return (
    <Modal
      {...dialog}
      withCloseButton
      size={800}
      fullScreen={isMobile}
      title={title}
      styles={columnStyles}
      data-testid="block-image-picker"
    >
      {signedOut ? (
        <Stack gap="md" align="flex-start">
          <Text size="sm">Sign in to choose from your images.</Text>
          <Button onClick={signIn}>Sign in</Button>
        </Stack>
      ) : (
        <Stack gap="sm" className="min-h-0 flex-1">
          <Text size="xs" c="dimmed">
            Your images that your content settings allow and that have finished scanning.
            {publicOnly && sources.includes('posted')
              ? ' Posted images are limited to public posts.'
              : ''}
          </Text>

          {sources.length > 1 ? (
            <Tabs
              value={source}
              onChange={(value) => value && setSource(value as BlockImagePickerSource)}
              keepMounted={false}
              className="flex min-h-0 flex-1 flex-col"
            >
              <Tabs.List mb="xs">
                {sources.map((s) => (
                  <Tabs.Tab key={s} value={s}>
                    {SOURCE_LABEL[s]}
                  </Tabs.Tab>
                ))}
              </Tabs.List>
              {sources.map((s) => (
                <Tabs.Panel key={s} value={s} className="flex min-h-0 flex-1 flex-col">
                  <SourceGrid source={s} {...gridFor(s)} />
                </Tabs.Panel>
              ))}
            </Tabs>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col">
              <SourceGrid source={source} {...gridFor(source)} />
            </div>
          )}

          <Stack gap="xs" className="shrink-0">
            {multiple && selected.length > 0 && (
              <SelectedTray selected={selected} onRemove={remove} />
            )}
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" c="dimmed" data-testid="block-image-picker-count">
                {multiple ? `${selected.length} of ${max} selected` : ''}
              </Text>
              <Group gap="xs" wrap="nowrap">
                <Button variant="default" onClick={dialog.onClose}>
                  Cancel
                </Button>
                <Button onClick={confirm} disabled={selected.length === 0}>
                  {selected.length > 1 ? `Use ${selected.length} images` : 'Use image'}
                </Button>
              </Group>
            </Group>
          </Stack>
        </Stack>
      )}
    </Modal>
  );
}

function SelectedTray({
  selected,
  onRemove,
}: {
  selected: SelectedImage[];
  onRemove: (image: SelectedImage) => void;
}) {
  return (
    <div
      role="list"
      aria-label="Selected images"
      data-testid="block-image-picker-tray"
      className="flex gap-2 overflow-x-auto pb-1"
    >
      {selected.map((image, index) => {
        const label = `Remove selected image ${index + 1} (${SOURCE_LABEL[image.source]})`;
        return (
          <div role="listitem" key={`${image.source}:${image.url}`} className="shrink-0">
            <Tooltip label={label} withinPortal>
              <UnstyledButton
                aria-label={label}
                onClick={() => onRemove(image)}
                className="relative block overflow-hidden rounded-md"
                style={{ width: TRAY_THUMB_PX, height: TRAY_THUMB_PX }}
              >
                <EdgeMedia
                  alt=""
                  src={image.thumbnail}
                  type="image"
                  width={THUMB_WIDTH}
                  hiDpi
                  sourceWidth={image.width}
                  loading="lazy"
                  className="size-full object-cover"
                />
                <span className="absolute inset-x-0 bottom-0 bg-black/60 text-center text-[10px] leading-4 text-white">
                  {SOURCE_LABEL[image.source]}
                </span>
                <ThemeIcon
                  size={16}
                  radius="xl"
                  color="dark"
                  className="absolute right-0.5 top-0.5"
                  aria-hidden
                >
                  <IconX size={10} />
                </ThemeIcon>
              </UnstyledButton>
            </Tooltip>
          </div>
        );
      })}
    </div>
  );
}

type GridSelection = {
  browsingLevel: number;
  selected: SelectedImage[];
  atMax: boolean;
  onToggle: (image: PickableImage) => void;
};

type JumpTo = {
  /** The day jumped to, `YYYY-MM-DD`, or `''` for the newest images. */
  jumpTo: string;
  onJumpTo: (value: string) => void;
};

function SourceGrid({
  source,
  dropPostedPicks,
  publicOnly,
  jumpTo,
  onJumpTo,
  ...selection
}: GridSelection &
  JumpTo & { source: BlockImagePickerSource; dropPostedPicks: () => void; publicOnly: boolean }) {
  const toDate = useMemo(() => jumpDateToBound(jumpTo) ?? undefined, [jumpTo]);
  return (
    <>
      <JumpToDate source={source} value={jumpTo} onChange={onJumpTo} />
      {source === 'posted' ? (
        <PostedGrid
          dropPostedPicks={dropPostedPicks}
          toDate={toDate}
          publicOnly={publicOnly}
          {...selection}
        />
      ) : (
        <GeneratedGrid toDate={toDate} {...selection} />
      )}
    </>
  );
}

/**
 * "Jump to date": restarts the list at the chosen day instead of the newest image, so an older
 * image is reached without scrolling through everything after it. A native date input: on a phone
 * it opens the platform's own picker, where reaching a year back is a couple of flicks.
 */
function JumpToDate({
  source,
  value,
  onChange,
}: {
  source: BlockImagePickerSource;
  value: string;
  onChange: (value: string) => void;
}) {
  const isMobile = useIsMobile({ type: 'media' });
  // What the input holds while the viewer edits it. A native date input reports `''` until every
  // part of the date is filled in, and steps through a whole date per arrow-key press; a whole date
  // is applied once it has held still for `PICKER_JUMP_DEBOUNCE_MS`, so the grid is replaced once
  // rather than flashing through every intermediate date.
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const pending = useRef<number>();
  const apply = useRef(onChange);
  apply.current = onChange;
  useEffect(() => () => window.clearTimeout(pending.current), []);

  function applyNow(next: string) {
    window.clearTimeout(pending.current);
    onChange(next);
  }

  const today = toDateInputValue(new Date());
  return (
    <Group gap="xs" mb="xs" wrap="nowrap" align="flex-end" className="shrink-0">
      <TextInput
        type="date"
        // 16px text on a phone: iOS zooms the page into any field set smaller when it is focused.
        size={isMobile ? 'md' : 'xs'}
        label="Jump to date"
        value={draft}
        min={toDateInputValue(PICKER_JUMP_MIN_DATE)}
        max={today}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          window.clearTimeout(pending.current);
          if (jumpDateToBound(next)) {
            pending.current = window.setTimeout(() => apply.current(next), PICKER_JUMP_DEBOUNCE_MS);
          }
        }}
        onBlur={(event) => {
          // Emptied, not half-edited (a half-edited date also reads `''`, but as bad input).
          const input = event.currentTarget;
          if (input.value === '' && !input.validity.badInput && value !== '') applyNow('');
        }}
        className="max-w-[200px] flex-1"
      />
      {value ? (
        <Button size="xs" variant="subtle" onClick={() => applyNow('')}>
          Back to newest
        </Button>
      ) : (
        <Text size="xs" c="dimmed" pb={6}>
          Newest {SOURCE_LABEL[source].toLowerCase()} images first
        </Text>
      )}
    </Group>
  );
}

function PostedGrid({
  dropPostedPicks,
  toDate,
  publicOnly,
  ...selection
}: GridSelection & { dropPostedPicks: () => void; toDate: Date | undefined; publicOnly: boolean }) {
  const { data, isLoading, isError, isFetching, hasNextPage, fetchNextPage, refetch } =
    trpc.blockImagePicker.getPosted.useInfiniteQuery(
      // Sent only when asked for, so a picker without it requests exactly what it did before.
      { ...(toDate ? { toDate } : {}), ...(publicOnly ? { publicOnly: true } : {}) },
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
          return pick
            ? [{ thumbnail: item.key, dateLabel: formatDateNullable(item.createdAt), pick }]
            : [];
        })
      ),
    [data]
  );

  // The first page object survives loading further pages and is replaced when the list is reset,
  // which a loading flag cannot be relied on to show: a reset that is answered at once never
  // renders as loading.
  const listKey = data?.pages[0];
  const bound = toDate?.getTime();

  // When the list on screen is replaced by another at the same date, picks made from the old one go
  // with it; a jump to another date keeps them (`shouldDropPostedPicks`).
  const listed = useRef({ listKey, bound });
  useEffect(() => {
    const previous = listed.current;
    listed.current = { listKey, bound };
    if (shouldDropPostedPicks(previous, { listKey, bound })) dropPostedPicks();
  }, [listKey, bound, dropPostedPicks]);

  return (
    <PickGrid
      source="posted"
      listKey={listKey}
      images={images}
      loading={isLoading}
      failed={isError}
      fetching={isFetching}
      hasMore={!!hasNextPage}
      onLoadMore={fetchNextPage}
      onRetry={data ? fetchNextPage : refetch}
      bounded={!!toDate}
      {...selection}
    />
  );
}

function GeneratedGrid({ toDate, ...selection }: GridSelection & { toDate: Date | undefined }) {
  const { browsingLevel } = selection;
  const { data, isFetching, isFetchingNextPage, isError, hasNextPage, fetchNextPage, refetch } =
    useGetTextToImageRequests(
      { tags: [WORKFLOW_TAGS.IMAGE], ...(toDate ? { toDate } : {}) },
      { enabled: true, ignoreFilters: true }
    );

  const images = useMemo(
    () =>
      data.flatMap((workflow) =>
        workflow.succeededOutput.flatMap((output): PickableImage[] => {
          const pick = projectGeneratedPick(output, browsingLevel);
          return pick
            ? [{ thumbnail: output.url, dateLabel: formatDateNullable(workflow.createdAt), pick }]
            : [];
        })
      ),
    [data, browsingLevel]
  );

  return (
    <PickGrid
      source="generated"
      listKey={`${browsingLevel}:${toDate?.getTime() ?? ''}`}
      images={images}
      loading={isFetching && !isFetchingNextPage && data.length === 0}
      failed={isError}
      fetching={isFetching}
      hasMore={!!hasNextPage}
      onLoadMore={fetchNextPage}
      onRetry={data.length > 0 ? fetchNextPage : refetch}
      bounded={!!toDate}
      {...selection}
    />
  );
}

type PickGridProps = GridSelection & {
  source: BlockImagePickerSource;
  /** Changes when the list is replaced by a different one, not when it gains a page. */
  listKey: unknown;
  images: PickableImage[];
  loading: boolean;
  failed: boolean;
  fetching: boolean;
  /** More pages exist. A page can hold nothing pickable, so an empty grid is not the end. */
  hasMore: boolean;
  onLoadMore: () => unknown;
  onRetry: () => unknown;
  bounded: boolean;
};

function PickGrid({
  source,
  listKey,
  images,
  loading,
  failed,
  fetching,
  hasMore,
  onLoadMore,
  onRetry,
  bounded,
  selected,
  atMax,
  onToggle,
}: PickGridProps) {
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

  // A different list: what the previous one's pages held says nothing about it.
  useEffect(() => {
    setEmptyStreak(0);
    setLoad(null);
  }, [listKey]);

  if (loading) {
    return (
      <Center py="xl" className="flex-1">
        <Loader />
      </Center>
    );
  }

  if (images.length === 0 && !hasMore && !failed) {
    return (
      <Text size="sm" c="dimmed" py="xl" ta="center">
        {bounded
          ? 'None of your images from on or before this date can be used here.'
          : EMPTY_MESSAGE[source]}
      </Text>
    );
  }

  const autoLoad = hasMore && !failed && emptyStreak < MAX_EMPTY_AUTO_PAGES;

  return (
    <VirtualTiles
      source={source}
      images={images}
      selected={selected}
      atMax={atMax}
      onToggle={onToggle}
    >
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
          <LoadMoreButton
            size="xs"
            variant="default"
            onClick={() => fetchPage(onLoadMore)}
            loading={fetching || !!load}
          />
        </Stack>
      ) : null}
    </VirtualTiles>
  );
}

/**
 * The grid's scroll box. Only the rows in or near view are mounted: a library loaded page after
 * page would otherwise keep every tile, and every decoded image, in the document. `children` (the
 * loader, retry or "Load more") follows the last row.
 *
 * A separate component so the scroll box exists when its measuring effect runs (`PickGrid` returns
 * early while loading or empty).
 */
function VirtualTiles({
  source,
  images,
  selected,
  atMax,
  onToggle,
  children,
}: Pick<GridSelection, 'selected' | 'atMax' | 'onToggle'> & {
  source: BlockImagePickerSource;
  images: PickableImage[];
  children: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth - GRID_INSET_PX * 2);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { columns, tile } = pickerGridLayout(width);
  const rowHeight = tile + PICKER_TILE_GAP_PX;
  const rowCount = width > 0 ? Math.ceil(images.length / columns) : 0;

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    paddingStart: GRID_INSET_PX,
    overscan: 2,
  });

  // Every row's size is `rowHeight`; the virtualizer caches sizes, so a new width re-lays them out.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  return (
    <Box
      ref={scrollRef}
      className="min-h-0 flex-1"
      style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
      data-testid="block-image-picker-scroll"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.index}
            style={{
              position: 'absolute',
              top: 0,
              left: GRID_INSET_PX,
              right: GRID_INSET_PX,
              transform: `translateY(${row.start}px)`,
              display: 'grid',
              gridTemplateColumns: `repeat(${columns}, ${tile}px)`,
              gap: PICKER_TILE_GAP_PX,
            }}
          >
            {images
              .slice(row.index * columns, row.index * columns + columns)
              .map((image, offset) => (
                <PickTile
                  key={image.pick.url}
                  source={source}
                  index={row.index * columns + offset}
                  image={image}
                  size={tile}
                  isSelected={selected.some((s) => isSamePick(s, image.pick))}
                  atMax={atMax}
                  onToggle={onToggle}
                />
              ))}
          </div>
        ))}
      </div>
      {children}
    </Box>
  );
}

const PickTile = memo(function PickTile({
  source,
  index,
  image,
  size,
  isSelected,
  atMax,
  onToggle,
}: {
  source: BlockImagePickerSource;
  index: number;
  image: PickableImage;
  size: number;
  isSelected: boolean;
  atMax: boolean;
  onToggle: (image: PickableImage) => void;
}) {
  const disabled = atMax && !isSelected;
  const date = image.dateLabel ? `, ${image.dateLabel}` : '';
  return (
    <UnstyledButton
      aria-label={`${SOURCE_LABEL[source]} image ${index + 1}${date}`}
      aria-pressed={isSelected}
      disabled={disabled}
      onClick={() => onToggle(image)}
      className={clsx(
        'relative overflow-hidden rounded-md',
        isSelected && 'ring-2 ring-blue-5',
        disabled && 'cursor-not-allowed opacity-40'
      )}
      style={{ width: size, height: size }}
    >
      <EdgeMedia
        alt=""
        src={image.thumbnail}
        type="image"
        // Generated outputs are not storage keys: their url is passed through unresized.
        width={THUMB_WIDTH}
        hiDpi
        sourceWidth={image.pick.width}
        loading="lazy"
        className="size-full object-cover"
      />
      {image.dateLabel && (
        // Visible copy of the date in the label; the label already carries it for assistive tech.
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-black/60 px-1 text-center text-[11px] leading-4 text-white"
        >
          {image.dateLabel}
        </span>
      )}
      {isSelected && (
        <ThemeIcon size="sm" radius="xl" className="absolute right-1.5 top-1.5">
          <IconCheck size={14} />
        </ThemeIcon>
      )}
    </UnstyledButton>
  );
});
