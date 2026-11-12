import { Button, FileButton, Progress, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconLoader2, IconMusic, IconPhotoEdit } from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo, useRef } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import { withMetadata } from '~/components/Post/EditV2/PostImageCards/SongDetails';
import {
  SONG_COVER_ACCEPT,
  useSongCoverUpload,
} from '~/components/Post/EditV2/PostImageCards/useSongCoverUpload';
import type {
  PostEditImageDetail,
  SongCover as SongCoverRow,
} from '~/server/services/post.service';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { useImageStore } from '~/store/image.store';

const tileSurface = 'rounded-xl bg-gray-2 dark:bg-dark-6';

/** Stands in for a song's cover wherever the post editor would show an image. */
export function SongGlyphTile({ className }: { className?: string }) {
  return (
    <div
      data-testid="song-tile"
      className={clsx(
        'flex shrink-0 items-center justify-center text-gray-6 dark:text-dark-2',
        tileSurface,
        className
      )}
    >
      <IconMusic size={64} stroke={1.5} />
    </div>
  );
}

const noCover = { id: 0 };

type CoverView = 'empty' | 'uploading' | 'error' | 'processing' | 'blocked' | 'failed' | 'done';

function coverView(cover: SongCoverRow | null): CoverView {
  if (!cover) return 'empty';
  if (cover.ingestion === ImageIngestionStatus.Blocked || cover.blockedFor) return 'blocked';
  if (cover.ingestion === ImageIngestionStatus.Scanned) return 'done';
  if (
    cover.ingestion === ImageIngestionStatus.Error ||
    cover.ingestion === ImageIngestionStatus.NotFound
  )
    return 'failed';
  return 'processing';
}

/** The cover tile of a song in the post editor, where its owner adds or changes the cover. */
export function SongCover({ image }: { image: PostEditImageDetail }) {
  const updateImage = usePostEditStore((state) => state.updateImage);
  // A scan result arrives as a signal into the image store, so the tile follows it without a reload.
  const storedCover = useMemo(() => image.cover ?? noCover, [image.cover]);
  const liveCover = useImageStore(storedCover);
  const cover = image.cover ? (liveCover as SongCoverRow) : null;

  const { state, busy, preview, pick, retry } = useSongCoverUpload({
    songId: image.id,
    onSaved: (saved) =>
      updateImage(image.id, (song) => {
        song.cover = saved;
        song.metadata = withMetadata(song.metadata, { coverImageId: saved.id });
      }),
  });

  const saved = coverView(cover);
  const view: CoverView =
    state.status === 'uploading' || state.status === 'saving'
      ? 'uploading'
      : state.status === 'error'
      ? 'error'
      : saved;
  // A failed replacement keeps showing the clean cover it would have replaced.
  const src =
    saved === 'done' && (view === 'done' || view === 'error')
      ? cover?.url
      : view === 'uploading' || view === 'processing'
      ? preview
      : undefined;

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-xl">
      {src ? (
        <EdgeMedia
          src={src}
          type="image"
          width={320}
          name="Song cover"
          className={clsx('size-full object-cover', view !== 'done' && 'opacity-40')}
          wrapperProps={{ className: 'size-full' }}
        />
      ) : view === 'uploading' || view === 'processing' ? (
        // The status panel carries the spinner and label; a glyph under it would stack on them.
        <div className={clsx('size-full', tileSurface)} />
      ) : (
        <SongGlyphTile className="size-full" />
      )}

      <CoverStatus view={view} state={state} onRetry={retry} />

      <CoverPicker
        label={saved === 'empty' ? 'Add cover' : 'Change cover'}
        alwaysShown={
          view === 'empty' || view === 'error' || view === 'blocked' || view === 'failed'
        }
        disabled={busy}
        onPick={pick}
      />
    </div>
  );
}

function CoverStatus({
  view,
  state,
  onRetry,
}: {
  view: CoverView;
  state: ReturnType<typeof useSongCoverUpload>['state'];
  onRetry: () => void;
}) {
  const panel =
    'pointer-events-none absolute inset-0 z-[15] flex flex-col items-center justify-center gap-2 bg-black/50 p-4 text-center text-sm font-semibold text-white';

  if (view === 'uploading') {
    const progress = state.status === 'uploading' ? state.progress : 100;
    return (
      <div className={panel} role="status">
        <span>{state.status === 'saving' ? 'Saving cover' : `Uploading ${progress}%`}</span>
        <Progress
          value={progress}
          size="sm"
          className="w-3/4"
          aria-label="Cover upload progress"
          animated={state.status === 'saving'}
        />
      </div>
    );
  }
  if (view === 'processing')
    return (
      <div className={panel} role="status">
        <IconLoader2 size={24} className="animate-spin" aria-hidden />
        <span>Processing</span>
      </div>
    );
  if (view === 'blocked' || view === 'failed')
    return (
      <div className={clsx(panel, 'pb-14')} role="status">
        <IconAlertTriangle size={24} aria-hidden />
        <span>
          {view === 'blocked' ? 'This cover was blocked' : "This cover couldn't be processed"}
        </span>
        <span className="text-xs font-normal">Choose another image.</span>
      </div>
    );
  if (view === 'error' && state.status === 'error')
    return (
      <div className={clsx(panel, 'pb-14')} role="alert">
        <IconAlertTriangle size={24} aria-hidden />
        <span className="font-normal">{state.message}</span>
        {state.canRetry && (
          <Button
            size="compact-sm"
            variant="white"
            color="dark"
            className="pointer-events-auto"
            onClick={onRetry}
          >
            Retry
          </Button>
        )}
      </div>
    );
  return null;
}

function CoverPicker({
  label,
  alwaysShown,
  disabled,
  onPick,
}: {
  label: string;
  /** Otherwise it shows on hover or keyboard focus, and always on a device without hover. */
  alwaysShown: boolean;
  disabled: boolean;
  onPick: (file: File | null) => void;
}) {
  const resetRef = useRef<() => void>(null);
  return (
    <FileButton
      resetRef={resetRef}
      accept={SONG_COVER_ACCEPT}
      disabled={disabled}
      onChange={(file) => {
        onPick(file);
        // Clears the input, so the same file can be chosen again after a failed upload.
        resetRef.current?.();
      }}
    >
      {(props) => (
        <UnstyledButton
          {...props}
          disabled={disabled}
          className="group/cover absolute inset-0 z-10 flex items-end justify-center rounded-xl p-3 disabled:cursor-not-allowed"
        >
          <span
            className={clsx(
              'flex items-center gap-1.5 rounded bg-dark-9/80 px-2.5 py-[5px] text-xs font-semibold text-white transition-opacity',
              !alwaysShown &&
                'opacity-0 group-hover/cover:opacity-100 group-focus-visible/cover:opacity-100 [@media(hover:none)]:opacity-100'
            )}
          >
            <IconPhotoEdit size={13} aria-hidden />
            {label}
          </span>
        </UnstyledButton>
      )}
    </FileButton>
  );
}
