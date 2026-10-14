import { ActionIcon, Button, Text, TextInput, Tooltip } from '@mantine/core';
import { DateTimePicker } from '@mantine/dates';
import { useVirtualizer } from '@tanstack/react-virtual';
import { IconPencil, IconTrash } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useIsMobile } from '~/hooks/useIsMobile';
import { formatDate } from '~/utils/date-helpers';
import type { ReviewPost } from './batch-composer.store';

const ROW_HEIGHT = 56;
const CARD_HEIGHT = 148;
const THUMBS_SHOWN = 4;
const THUMB_WIDTH = 96;

export function BatchReviewTable({
  posts,
  issueByKey,
  onTitleChange,
  onTimeChange,
  onRemove,
}: {
  posts: ReviewPost[];
  issueByKey: Map<string, string>;
  onTitleChange: (key: string, title: string | null) => void;
  onTimeChange: (key: string, publishedAt: Date) => void;
  onRemove: (key: string) => void;
}) {
  const isMobile = !!useIsMobile({ type: 'media', breakpoint: 'md' });
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: posts.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => (isMobile ? CARD_HEIGHT : ROW_HEIGHT),
    overscan: 8,
  });

  return (
    <div
      ref={scrollRef}
      className="max-h-[65vh] overflow-auto rounded-lg border border-gray-2 dark:border-dark-5"
      data-testid="batch-review-table"
    >
      {!isMobile && (
        <div className="sticky top-0 z-10 grid grid-cols-[48px_120px_minmax(0,1fr)_240px_90px] gap-2 border-b border-gray-2 bg-gray-0 px-3 py-2 text-xs font-medium text-gray-6 dark:border-dark-5 dark:bg-dark-7 dark:text-gray-4">
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

  const thumbs = (
    <div className="flex items-center gap-0.5">
      {post.media.slice(0, THUMBS_SHOWN).map((item) => (
        <EdgeMedia
          key={item.url}
          src={item.url}
          type={item.type}
          name={item.name}
          width={THUMB_WIDTH}
          anim={false}
          loading="lazy"
          alt=""
          className="size-8 rounded object-cover"
        />
      ))}
      {post.media.length > THUMBS_SHOWN && (
        <Text size="xs" c="dimmed">
          +{post.media.length - THUMBS_SHOWN}
        </Text>
      )}
    </div>
  );

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
        <div className="flex items-center gap-2">
          {thumbs}
          <div className="min-w-0 flex-1">{title}</div>
        </div>
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
      <div className="grid grid-cols-[48px_120px_minmax(0,1fr)_240px_90px] items-center gap-2 px-3 py-2">
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
