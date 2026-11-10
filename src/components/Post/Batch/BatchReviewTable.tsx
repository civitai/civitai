import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { CollisionDetection, DragEndEvent, Modifier } from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ActionIcon, Button, Text, TextInput } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { DateTimePicker } from '@mantine/dates';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IconGripVertical, IconPencil, IconTrash } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import type { RefObject } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useIsMobile } from '~/hooks/useIsMobile';
import { formatDate } from '~/utils/date-helpers';
import type { ReviewPost } from './batch-composer.store';
import type { UploadedMedia } from './batch-composer.utils';

const ROW_HEIGHT = 80;
const CARD_HEIGHT = 230;
const THUMB_SIZE = 64;

/** Only the dragged image's own post competes for the drop, so other posts never react. */
const sameCollection: CollisionDetection = (args) => {
  const postKey = args.active.data.current?.postKey;
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter(
      (container) => container.data.current?.postKey === postKey
    ),
  });
};

/** Keeps the dragged image inside the box that holds its post's images. */
const stayInPost: Modifier = ({ transform, draggingNodeRect, active }) => {
  const box = (
    active?.data.current?.boxRef as RefObject<HTMLElement> | undefined
  )?.current?.getBoundingClientRect();
  if (!box || !draggingNodeRect) return transform;
  return {
    ...transform,
    x: Math.min(
      Math.max(transform.x, box.left - draggingNodeRect.left),
      box.right - draggingNodeRect.right
    ),
    y: Math.min(
      Math.max(transform.y, box.top - draggingNodeRect.top),
      box.bottom - draggingNodeRect.bottom
    ),
  };
};

export function BatchReviewTable({
  posts,
  issueByKey,
  onTitleChange,
  onTimeChange,
  onRemove,
  onReorderMedia,
}: {
  posts: ReviewPost[];
  issueByKey: Map<string, string>;
  onTitleChange: (key: string, title: string | null) => void;
  onTimeChange: (key: string, publishedAt: Date) => void;
  onRemove: (key: string) => void;
  onReorderMedia: (key: string, fromUrl: string, toUrl: string) => void;
}) {
  const isMobile = !!useIsMobile({ type: 'media', breakpoint: 'md' });
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: posts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (isMobile ? CARD_HEIGHT : ROW_HEIGHT),
    overscan: 8,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = String(active.id);
    const to = String(over.id);
    const owner = posts.find(
      (post) => post.media.some((m) => m.url === from) && post.media.some((m) => m.url === to)
    );
    if (owner) onReorderMedia(owner.key, from, to);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sameCollection}
      modifiers={[stayInPost]}
      onDragEnd={handleDragEnd}
    >
      <div
        ref={scrollRef}
        className="max-h-[65vh] overflow-auto rounded-lg border border-gray-2 dark:border-dark-5"
        data-testid="batch-review-table"
      >
        {!isMobile && (
          <div className="sticky top-0 z-10 grid grid-cols-[48px_minmax(150px,280px)_minmax(0,1fr)_240px_90px] gap-2 border-b border-gray-2 bg-gray-0 px-3 py-2 text-xs font-medium text-gray-6 dark:border-dark-5 dark:bg-dark-7 dark:text-gray-4">
            <span>#</span>
            <span>Media</span>
            <span>Title</span>
            <span>Goes live</span>
            <span />
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((row) => {
            const post = posts[row.index];
            return (
              <div
                key={post.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${row.start}px)`,
                }}
              >
                <ReviewRow
                  index={row.index}
                  post={post}
                  issue={issueByKey.get(post.key)}
                  mobile={isMobile}
                  onTitleChange={(title) => onTitleChange(post.key, title)}
                  onTimeChange={(date) => onTimeChange(post.key, date)}
                  onRemove={() => onRemove(post.key)}
                />
              </div>
            );
          })}
        </div>
      </div>
    </DndContext>
  );
}

function ReviewRow({
  index,
  post,
  issue,
  mobile,
  onTitleChange,
  onTimeChange,
  onRemove,
}: {
  index: number;
  post: ReviewPost;
  issue?: string;
  mobile: boolean;
  onTitleChange: (title: string | null) => void;
  onTimeChange: (date: Date) => void;
  onRemove: () => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingTime, setEditingTime] = useState(false);
  const [draftTitle, setDraftTitle] = useState(post.title ?? '');

  const commitTitle = () => {
    onTitleChange(draftTitle.trim() || null);
    setEditingTitle(false);
  };

  const thumbs = <ReviewThumbs postKey={post.key} postNumber={index + 1} media={post.media} />;

  const title = editingTitle ? (
    <TextInput
      size="xs"
      value={draftTitle}
      onChange={(event) => setDraftTitle(event.currentTarget.value)}
      onBlur={commitTitle}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commitTitle();
        if (event.key === 'Escape') setEditingTitle(false);
      }}
      maxLength={255}
      autoFocus
      aria-label={`Title for post ${index + 1}`}
    />
  ) : (
    <div className="flex min-w-0 items-center gap-1">
      <Text
        size="sm"
        truncate
        className={clsx(!post.title && 'italic text-gray-6 dark:text-gray-5')}
      >
        {post.title ?? 'Untitled'}
      </Text>
      <ActionIcon
        size="xs"
        variant="subtle"
        aria-label={`Edit title of post ${index + 1}`}
        onClick={() => {
          setDraftTitle(post.title ?? '');
          setEditingTitle(true);
        }}
      >
        <IconPencil size={14} />
      </ActionIcon>
    </div>
  );

  const time = editingTime ? (
    <DateTimePicker
      size="xs"
      value={post.publishedAt}
      onChange={(value) => {
        if (value) onTimeChange(new Date(value));
      }}
      onBlur={() => setEditingTime(false)}
      valueFormat="ddd MMM D, h:mm A"
      minDate={new Date()}
      popoverProps={{ withinPortal: true, onClose: () => setEditingTime(false) }}
      clearable={false}
      defaultValue={post.publishedAt}
      aria-label={`Go-live time for post ${index + 1}`}
      w={220}
    />
  ) : (
    <div className="flex items-center gap-1">
      <Text size="sm" className="whitespace-nowrap">
        {formatDate(post.publishedAt, 'ddd MMM D, h:mm A')}
      </Text>
      <ActionIcon
        size="xs"
        variant="subtle"
        aria-label={`Edit time of post ${index + 1}`}
        onClick={() => setEditingTime(true)}
      >
        <IconPencil size={14} />
      </ActionIcon>
    </div>
  );

  const remove = (
    <Tooltip label="Remove from batch" withinPortal>
      <Button
        size="compact-xs"
        variant="subtle"
        color="red"
        leftSection={<IconTrash size={14} />}
        onClick={onRemove}
      >
        Remove
      </Button>
    </Tooltip>
  );

  const rowClass = clsx(
    'border-b border-gray-2 dark:border-dark-5',
    issue && 'bg-red-0 dark:bg-red-9/20'
  );

  if (mobile)
    return (
      <div
        className={clsx(rowClass, 'flex flex-col gap-2 px-3 py-2')}
        data-testid="batch-review-row"
      >
        <div className="flex items-center justify-between gap-2">
          <Text size="xs" c="dimmed">
            #{index + 1}
          </Text>
          {remove}
        </div>
        {thumbs}
        {title}
        {time}
        {issue && (
          <Text size="xs" c="red">
            {issue}
          </Text>
        )}
      </div>
    );

  return (
    <div className={rowClass} data-testid="batch-review-row">
      <div className="grid grid-cols-[48px_minmax(150px,280px)_minmax(0,1fr)_240px_90px] items-center gap-2 px-3 py-2">
        <Text size="sm" c="dimmed">
          {index + 1}
        </Text>
        {thumbs}
        {title}
        {time}
        {remove}
      </div>
      {issue && (
        <Text size="xs" c="red" className="px-3 pb-2">
          {issue}
        </Text>
      )}
    </div>
  );
}

function ReviewThumbs({
  postKey,
  postNumber,
  media,
}: {
  postKey: string;
  postNumber: number;
  media: UploadedMedia[];
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const thumbs = (
    <div
      ref={boxRef}
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label={`Images of post ${postNumber}`}
    >
      {media.map((item, position) => (
        <ReviewThumb
          key={item.url}
          item={item}
          postKey={postKey}
          boxRef={boxRef}
          label={`Image ${position + 1} of ${media.length}, post ${postNumber}`}
          sortable={media.length > 1}
        />
      ))}
    </div>
  );
  if (media.length < 2) return thumbs;
  return (
    <SortableContext items={media.map((item) => item.url)} strategy={rectSortingStrategy}>
      {thumbs}
    </SortableContext>
  );
}

function ReviewThumb({
  item,
  postKey,
  boxRef,
  label,
  sortable,
}: {
  item: UploadedMedia;
  postKey: string;
  boxRef: RefObject<HTMLElement | null>;
  label: string;
  sortable: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.url,
    data: { postKey, boxRef },
    disabled: !sortable,
  });
  return (
    <div
      ref={setNodeRef}
      data-testid="batch-review-thumb"
      data-url={item.url}
      aria-label={label}
      {...(sortable ? attributes : {})}
      {...(sortable ? listeners : {})}
      className={clsx(
        'relative shrink-0 overflow-hidden rounded',
        sortable && 'cursor-grab touch-manipulation',
        isDragging && 'relative z-10 cursor-grabbing opacity-80 shadow-lg'
      )}
      style={{
        width: THUMB_SIZE,
        height: THUMB_SIZE,
        transform: CSS.Transform.toString(transform),
        transition,
      }}
    >
      <EdgeMedia
        src={item.url}
        type={item.type}
        name={item.name}
        width={THUMB_SIZE * 2}
        anim={false}
        loading="lazy"
        alt=""
        draggable={false}
        className="size-full object-cover"
      />
      {!!item.nsfwLevel && (
        <BrowsingLevelBadge
          browsingLevel={item.nsfwLevel}
          size="xs"
          className="absolute bottom-0 left-0 px-1"
          data-testid="batch-review-level"
        />
      )}
      {sortable && (
        // The only part with touch-action: none, so a swipe that starts elsewhere on a
        // thumbnail still scrolls the list on a phone.
        <span
          aria-hidden
          data-testid="batch-review-thumb-handle"
          className="absolute bottom-0 right-0 flex size-6 touch-none items-end justify-end rounded-tl bg-black/40 p-0.5 text-white"
        >
          <IconGripVertical size={16} />
        </span>
      )}
    </div>
  );
}
