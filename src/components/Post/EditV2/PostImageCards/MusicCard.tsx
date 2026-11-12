import { ActionIcon, Switch, Textarea } from '@mantine/core';
import { IconCircleCheck, IconLock, IconMusic, IconPencil, IconTrash } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { Tooltip } from '~/components/MantineOverlays';
import { usePendingSave, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { SongPreviewPlayer } from '~/components/Post/EditV2/PostImageCards/SongPreviewPlayer';
import { useDeletePostImage } from '~/components/Post/EditV2/PostImageCards/useDeletePostImage';
import { POST_TITLE_MAX_LENGTH } from '~/server/common/constants';
import { audioMetadataSchema } from '~/server/schema/media.schema';
import type { PostEditImageDetail } from '~/server/services/post.service';
import { songAllowsRemix } from '~/shared/form-graph/generation/audio/song-metadata';
import { formatPlaybackTime } from '~/utils/audio-player';
import { useDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { isDefined } from '~/utils/type-guards';
import { trpc } from '~/utils/trpc';
import styles from './MusicCard.module.scss';

const dimmed = 'text-gray-6 dark:text-dark-2';

/** The stored metadata with `changes` applied; an undefined value removes its key. */
function withMetadata<T>(metadata: T, changes: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...(metadata as Record<string, unknown> | null) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

/** Stands in for a song's cover wherever the post editor would show an image. */
export function SongGlyphTile({ className }: { className?: string }) {
  return (
    <div
      data-testid="song-tile"
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-xl bg-gray-2 text-gray-6 dark:bg-dark-6 dark:text-dark-2',
        className
      )}
    >
      <IconMusic size={64} stroke={1.5} />
    </div>
  );
}

/** A song in the post editor. */
export function MusicCard({ image }: { image: PostEditImageDetail }) {
  const { id, hideMeta, metadata, meta, resourceHelper, lyrics, url } = image;
  const audio = audioMetadataSchema.partial().safeParse(metadata).data;
  const { onDelete, isDeleting } = useDeletePostImage(id, image.type);
  const updateImage = usePostEditStore((state) => state.updateImage);

  const onUpdateError = (error: { message: string }) =>
    showErrorNotification({ title: 'Failed to update song', error: new Error(error.message) });

  const toggleMutation = trpc.post.updateImage.useMutation({
    onSuccess: (_, { id, hideMeta, allowRemix }) =>
      updateImage(id, (image) => {
        if (hideMeta !== undefined) image.hideMeta = hideMeta;
        if (allowRemix !== undefined) image.metadata = withMetadata(image.metadata, { allowRemix });
      }),
    onError: onUpdateError,
  });

  const detail = [
    resourceHelper.find((r) => r.modelName)?.modelName,
    audio?.duration ? formatPlaybackTime(audio.duration) : undefined,
    meta?.seed !== undefined && meta?.seed !== null ? `seed ${meta.seed}` : undefined,
  ]
    .filter(isDefined)
    .join(' · ');

  return (
    <div className={clsx(styles.card, 'flex flex-col gap-3.5 rounded-2xl border p-4 @container')}>
      <div className="flex flex-col gap-4 @md:flex-row">
        <SongGlyphTile className="size-[168px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
          <div className="flex items-start gap-2">
            <SongTitleInput id={id} title={audio?.title ?? ''} />
            <Tooltip label="Remove song">
              <ActionIcon
                size={30}
                radius={8}
                variant="default"
                className="shrink-0 border-0 bg-gray-1 dark:bg-dark-5"
                aria-label="Remove song"
                loading={isDeleting}
                onClick={onDelete}
              >
                <IconTrash size={15} className={dimmed} />
              </ActionIcon>
            </Tooltip>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 rounded bg-green-1 px-2 py-[3px] text-[11px] font-bold leading-none text-green-8 dark:bg-[#1EBD8E33] dark:text-[#1EBD8E]">
              <IconCircleCheck size={12} />
              Made on Civitai
            </span>
            {detail && <span className={clsx('text-xs', dimmed)}>{detail}</span>}
          </div>
          <SongPreviewPlayer src={url} duration={audio?.duration} />
        </div>
      </div>
      {!!lyrics?.length && <LockedLyrics lines={lyrics} />}
      <div className="flex flex-col gap-4 @lg:flex-row @lg:gap-6">
        <SongSwitch
          label="Hide prompt"
          description="Hides the style prompt, lyrics prompt and seed, and removes Remix this recipe. Lyrics stay visible."
          checked={hideMeta}
          disabled={toggleMutation.isPending}
          onChange={(checked) => toggleMutation.mutate({ id, hideMeta: checked })}
        />
        <SongSwitch
          label="Allow remixes"
          description="Others can use this song's recipe in the generator."
          checked={songAllowsRemix(metadata)}
          disabled={toggleMutation.isPending}
          onChange={(checked) => toggleMutation.mutate({ id, allowRemix: checked })}
        />
      </div>
    </div>
  );
}

function SongTitleInput({ id, title: savedTitle }: { id: number; title: string }) {
  const [title, setTitle] = useState(savedTitle);
  const updateImage = usePostEditStore((state) => state.updateImage);
  const debounce = useDebouncer(1000);
  usePendingSave(`song-title-${id}`, debounce);

  const setStoredTitle = (value: string) =>
    updateImage(id, (image) => {
      image.metadata = withMetadata(image.metadata, { title: value || undefined });
    });

  const { mutate } = trpc.post.updateImage.useMutation({
    // Applied when sent, as the post title does: the store is what the editor hands back to the
    // cached post when the user navigates away mid-request.
    onMutate: ({ title }) => {
      if (title !== undefined) setStoredTitle(title);
    },
    onError: (error) => {
      setStoredTitle(savedTitle);
      showErrorNotification({
        title: 'Failed to save song title',
        error: new Error(error.message),
      });
    },
  });

  return (
    <div className="flex min-w-0 flex-1 items-start gap-2">
      <Textarea
        aria-label="Song title"
        placeholder="Untitled song"
        value={title}
        maxLength={POST_TITLE_MAX_LENGTH}
        autosize
        minRows={1}
        variant="unstyled"
        className="min-w-0 flex-1"
        classNames={{ input: styles.titleInput }}
        styles={{ input: { fontSize: 24, fontWeight: 700, lineHeight: 1.25, padding: 0 } }}
        onChange={(e) => {
          const value = e.currentTarget.value.replace(/\r?\n/g, ' ');
          setTitle(value);
          debounce(() => mutate({ id, title: value.trim() }));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        onBlur={() => debounce.flush()}
      />
      <IconPencil size={14} className={clsx('mt-2.5 shrink-0', dimmed)} aria-hidden />
    </div>
  );
}

function LockedLyrics({ lines }: { lines: { t: number | null; text: string }[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <IconLock size={13} className={dimmed} aria-hidden />
        <span className="text-[13px] font-semibold text-gray-9 dark:text-dark-0">Lyrics</span>
        <span className={clsx('text-xs', dimmed)}>
          Locked · the generator&apos;s timestamps drive synced lyrics
        </span>
      </div>
      <div className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-md border border-gray-3 bg-white p-3 opacity-85 dark:border-dark-4 dark:bg-dark-6">
        {lines.map((line, index) => (
          <div key={index} className="flex gap-3">
            {line.t !== null && (
              <span className={clsx('w-8 shrink-0 text-xs tabular-nums leading-4', dimmed)}>
                {formatPlaybackTime(line.t / 1000)}
              </span>
            )}
            <span
              className={clsx(
                'min-w-0 whitespace-pre-wrap break-words text-[13px] leading-4',
                /^\[.*\]$/.test(line.text.trim()) ? dimmed : 'text-gray-9 dark:text-dark-0'
              )}
            >
              {line.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SongSwitch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Switch
      className="flex-1"
      size="sm"
      labelPosition="left"
      label={label}
      description={description}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.currentTarget.checked)}
      classNames={{
        body: 'justify-between gap-3',
        labelWrapper: 'flex-1',
        label: 'text-[13px] font-semibold text-black dark:text-white p-0',
        description: 'text-xs mt-0.5',
      }}
    />
  );
}
