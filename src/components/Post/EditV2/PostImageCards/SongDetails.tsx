import { Textarea, UnstyledButton } from '@mantine/core';
import { IconCircleCheck, IconLock, IconPencil } from '@tabler/icons-react';
import clsx from 'clsx';
import { useRef, useState } from 'react';
import { usePendingSave, usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { POST_TITLE_MAX_LENGTH } from '~/server/common/constants';
import { audioMetadataSchema } from '~/server/schema/media.schema';
import type { PostEditImageDetail } from '~/server/services/post.service';
import { formatPlaybackTime } from '~/utils/audio-player';
import { useDebouncer } from '~/utils/debouncer';
import { showErrorNotification } from '~/utils/notifications';
import { isDefined } from '~/utils/type-guards';
import { trpc } from '~/utils/trpc';

export const songDimmed = 'text-gray-6 dark:text-dark-2';

/** The stored metadata with `changes` applied; an undefined value removes its key. */
export function withMetadata<T>(metadata: T, changes: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...(metadata as Record<string, unknown> | null) };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

/** A song's title, where it was made, and its lyrics. */
export function SongDetails({ image }: { image: PostEditImageDetail }) {
  const { id, metadata, meta, resourceHelper, lyrics } = image;
  const audio = audioMetadataSchema.partial().safeParse(metadata).data;

  const detail = [
    resourceHelper.find((r) => r.modelName)?.modelName,
    audio?.duration ? formatPlaybackTime(audio.duration) : undefined,
    meta?.seed !== undefined && meta?.seed !== null ? `seed ${meta.seed}` : undefined,
  ]
    .filter(isDefined)
    .join(' · ');

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2.5">
        <SongTitleInput id={id} title={audio?.title ?? ''} />
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 rounded bg-green-1 px-2 py-[3px] text-[11px] font-bold leading-none text-green-8 dark:bg-[color-mix(in_srgb,var(--mantine-color-success-5)_20%,transparent)] dark:text-[var(--mantine-color-success-5)]">
            <IconCircleCheck size={12} />
            Made on Civitai
          </span>
          {detail && <span className={clsx('text-xs', songDimmed)}>{detail}</span>}
        </div>
      </div>
      {!!lyrics?.length && <SongLyrics lines={lyrics} />}
    </div>
  );
}

function SongTitleInput({ id, title: savedTitle }: { id: number; title: string }) {
  const [title, setTitle] = useState(savedTitle);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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

  const titleStyle = 'text-2xl font-bold leading-tight';

  return (
    <div className="flex min-w-0 items-start gap-1">
      {/*
        A hidden copy of the title sizes the field, so the pencil follows the text. The copy's 2px
        right padding is headroom against rounding wrapping the last word; the wrapper padding
        (offset by -ml-1 at rest) holds the hover background and, with the gap, makes 8px to the pencil.
      */}
      <div className="-ml-1 grid min-w-0 rounded pl-1 pr-0.5 transition-colors focus-within:bg-gray-1 hover:bg-gray-1 dark:focus-within:bg-dark-6 dark:hover:bg-dark-6">
        <span
          aria-hidden
          className={clsx(
            'invisible col-start-1 row-start-1 min-w-0 whitespace-pre-wrap break-words pr-0.5',
            titleStyle
          )}
        >
          {title || 'Untitled song'}
        </span>
        <Textarea
          ref={inputRef}
          aria-label="Song title"
          placeholder="Untitled song"
          value={title}
          maxLength={POST_TITLE_MAX_LENGTH}
          autosize
          minRows={1}
          variant="unstyled"
          className="col-start-1 row-start-1 min-w-0"
          // Classes, not `styles`: react-textarea-autosize refuses an inline min-height. Without
          // `min-h-0` Mantine's input min-height keeps the one-row title taller than its line;
          // `w-0 min-w-full` leaves the width to the hidden copy rather than the textarea's columns,
          // and `border-0` drops the unstyled variant's transparent border the copy does not have.
          classNames={{ input: clsx('min-h-0 w-0 min-w-full border-0 p-0', titleStyle) }}
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
      </div>
      <UnstyledButton
        aria-label="Edit song title"
        onClick={() => inputRef.current?.focus()}
        className={clsx('mt-2 shrink-0 rounded', songDimmed)}
      >
        <IconPencil size={14} />
      </UnstyledButton>
    </div>
  );
}

function SongLyrics({ lines }: { lines: { t: number | null; text: string }[] }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <IconLock size={13} className={songDimmed} aria-hidden />
        <span className="text-[13px] font-semibold text-gray-9 dark:text-dark-0">Lyrics</span>
        <span className={clsx('text-xs', songDimmed)}>
          Locked · the generator&apos;s timestamps drive synced lyrics
        </span>
      </div>
      <div className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-md border border-gray-3 bg-white p-3 opacity-85 dark:border-dark-4 dark:bg-dark-6">
        {lines.map((line, index) => (
          <div key={index} className="flex gap-3">
            {line.t !== null && (
              <span className={clsx('w-8 shrink-0 text-xs tabular-nums leading-4', songDimmed)}>
                {formatPlaybackTime(line.t / 1000)}
              </span>
            )}
            <span
              className={clsx(
                'min-w-0 whitespace-pre-wrap break-words text-[13px] leading-4',
                /^\[.*\]$/.test(line.text.trim()) ? songDimmed : 'text-gray-9 dark:text-dark-0'
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
