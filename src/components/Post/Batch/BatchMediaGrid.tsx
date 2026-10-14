import { Button, NumberInput, Progress, Radio, RingProgress, Text, Tooltip } from '@mantine/core';
import {
  IconArrowsShuffle,
  IconPhotoPlus,
  IconRefresh,
  IconVideo,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import type { TrackedFile } from '~/components/FileUpload/FileUploadProvider';
import { MediaDropzone } from '~/components/Image/ImageDropzone/MediaDropzone';
import { UploadNotice } from '~/components/UploadNotice/UploadNotice';
import type { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { POST_BATCH_MAX_IMAGES } from '@civitai/shared/post-scheduling';
import { useBatchComposerStore } from './batch-composer.store';
import { groupIntoPosts } from './batch-composer.utils';

export type DroppedFile = { file: File; meta?: Record<string, unknown> };

/** The smallest edge size; the cells are 96px wide. */
const THUMB_WIDTH = 96;

export function BatchMediaGrid({
  onDrop,
  onImport,
  canAdd,
  error,
  loading,
  uploading,
  skippedCount,
}: {
  onDrop: (files: DroppedFile[]) => void;
  onImport: () => void;
  canAdd: boolean;
  error?: Error;
  loading: boolean;
  uploading: TrackedFile[];
  /** Files dropped past the batch limit on the last drop. */
  skippedCount: number;
}) {
  const [media, imagesPerPost, removeMedia, shuffleMedia, setImagesPerPost] = useBatchComposerStore(
    (state) => [
      state.media,
      state.imagesPerPost,
      state.removeMedia,
      state.shuffleMedia,
      state.setImagesPerPost,
    ]
  );

  const uploaded = media.filter((x) => x.status === 'added');
  const failed = media.filter((x) => x.status === 'error');
  const blocked = media.filter((x) => x.status === 'blocked');
  const inFlight = uploading.filter((x) => x.status === 'pending' || x.status === 'uploading');
  const total = uploaded.length + failed.length + inFlight.length;
  const uploadProgress = inFlight.length
    ? Math.round(
        ((uploaded.length + inFlight.reduce((sum, file) => sum + file.progress / 100, 0)) / total) *
          100
      )
    : 100;
  const postCount = groupIntoPosts(uploaded, imagesPerPost).length;

  const retry = async (item: MediaUploadOnCompleteProps) => {
    const blob = await fetch(item.objectUrl).then((response) => response.blob());
    removeMedia(item.url);
    onDrop([{ file: new File([blob], item.name, { type: item.mimeType }), meta: item.meta }]);
  };

  const limitError =
    skippedCount > 0
      ? new Error(
          `You can add up to ${POST_BATCH_MAX_IMAGES} files per batch. ${skippedCount} were skipped.`
        )
      : error;

  return (
    <div className="flex flex-col gap-3">
      <MediaDropzone
        onDrop={onDrop}
        accept={[...IMAGE_MIME_TYPE, ...VIDEO_MIME_TYPE]}
        disabled={!canAdd}
        error={limitError}
        loading={loading}
        label="Drop images or videos here, or click to browse"
        className="rounded-lg"
        data-testid="batch-dropzone"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="light"
          leftSection={<IconPhotoPlus size={16} />}
          onClick={onImport}
          disabled={!canAdd}
        >
          Import from Generator
        </Button>
        {!media.length && !inFlight.length && <UploadNotice className="ml-auto text-left" />}
      </div>

      {(inFlight.length > 0 || failed.length > 0) && (
        <div className="flex flex-col gap-1" data-testid="batch-upload-progress">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {inFlight.length
                ? `Uploading ${uploaded.length}/${total} · ${uploadProgress}%`
                : `Uploaded ${uploaded.length}/${total}`}
            </span>
            {failed.length > 0 && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                leftSection={<IconRefresh size={14} />}
                onClick={() => failed.forEach((item) => void retry(item))}
              >
                {failed.length} failed · Retry all
              </Button>
            )}
          </div>
          <Progress value={uploadProgress} size="sm" animated={inFlight.length > 0} />
        </div>
      )}

      {(media.length > 0 || inFlight.length > 0) && (
        <div
          className="grid grid-cols-3 gap-2 sm:grid-cols-[repeat(auto-fill,minmax(96px,1fr))]"
          data-testid="batch-media-grid"
        >
          {media.map((item) => (
            <MediaThumb
              key={item.url}
              item={item}
              onRemove={() => removeMedia(item.url)}
              onRetry={() => void retry(item)}
            />
          ))}
          {inFlight.map((file) => (
            <div
              key={file.name + file.size}
              className="relative flex aspect-square items-center justify-center rounded-md bg-gray-1 dark:bg-dark-6"
              title={`Uploading ${file.name}`}
            >
              <RingProgress
                size={56}
                thickness={5}
                sections={[{ value: file.progress, color: 'blue' }]}
                label={
                  <Text size="xs" ta="center">
                    {Math.round(file.progress)}%
                  </Text>
                }
              />
            </div>
          ))}
        </div>
      )}

      {(blocked.length > 0 || failed.length > 0) && (
        <div className="flex flex-col gap-0.5">
          {blocked.length > 0 && (
            <Text size="sm" c="red">
              {blocked.length} {blocked.length === 1 ? 'image was' : 'images were'} blocked and
              won&apos;t be posted. Hover for details.
            </Text>
          )}
          {failed.length > 0 && (
            <Text size="sm" c="red">
              {failed.length} upload{failed.length === 1 ? '' : 's'} failed. Retry or remove them to
              continue.
            </Text>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Radio.Group
          label="Posts"
          value={imagesPerPost === 1 ? 'single' : 'grouped'}
          onChange={(value) =>
            setImagesPerPost(value === 'single' ? 1 : Math.max(2, imagesPerPost))
          }
        >
          <div className="flex flex-wrap items-center gap-4">
            <Radio value="single" label="1 image each" />
            <div className="flex items-center gap-2">
              <Radio value="grouped" label="" aria-label="Several images per post" />
              <NumberInput
                aria-label="Images per post"
                value={imagesPerPost === 1 ? 2 : imagesPerPost}
                onChange={(value) => setImagesPerPost(Number(value) || 2)}
                min={2}
                max={POST_IMAGE_LIMIT}
                step={1}
                allowDecimal={false}
                w={80}
                data-testid="batch-images-per-post"
              />
              <Text size="sm">per post</Text>
            </div>
            {uploaded.length > 0 && (
              <Text size="sm" c="dimmed" data-testid="batch-grouping-summary">
                → {postCount} post{postCount === 1 ? '' : 's'}
                {imagesPerPost > 1 ? ` of up to ${imagesPerPost}` : ''}
              </Text>
            )}
          </div>
        </Radio.Group>
        <div>
          <Button
            size="compact-sm"
            variant="default"
            leftSection={<IconArrowsShuffle size={14} />}
            onClick={shuffleMedia}
            disabled={uploaded.length < 2}
          >
            Shuffle order
          </Button>
        </div>
      </div>
    </div>
  );
}

function MediaThumb({
  item,
  onRemove,
  onRetry,
}: {
  item: MediaUploadOnCompleteProps;
  onRemove: () => void;
  onRetry: () => void;
}) {
  const status = item.status;
  const tooltip =
    status === 'blocked'
      ? `Blocked${item.blockedFor ? `: ${item.blockedFor}` : ''}`
      : status === 'error'
      ? 'Upload failed'
      : item.name;
  return (
    <Tooltip label={tooltip} withinPortal>
      <div
        className={clsx(
          'group relative aspect-square overflow-hidden rounded-md bg-gray-1 dark:bg-dark-6',
          status === 'blocked' && 'ring-2 ring-red-6',
          status === 'error' && 'ring-2 ring-yellow-6'
        )}
        data-status={status}
        data-testid="batch-media-thumb"
      >
        <EdgeMedia
          src={item.url}
          type={item.type}
          name={item.name}
          width={THUMB_WIDTH}
          anim={false}
          loading="lazy"
          alt={item.name}
          className="size-full object-cover"
        />
        {item.type === 'video' && (
          <IconVideo size={16} className="absolute bottom-1 left-1 text-white drop-shadow" />
        )}
        {status !== 'added' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-xs font-semibold uppercase text-white">
            {status === 'blocked' ? 'Blocked' : 'Failed'}
          </div>
        )}
        <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {status === 'error' && (
            <button
              type="button"
              aria-label={`Retry ${item.name}`}
              onClick={onRetry}
              className="rounded bg-black/70 p-0.5 text-white"
            >
              <IconRefresh size={14} />
            </button>
          )}
          <button
            type="button"
            aria-label={`Remove ${item.name}`}
            onClick={onRemove}
            className="rounded bg-black/70 p-0.5 text-white"
          >
            <IconX size={14} />
          </button>
        </div>
      </div>
    </Tooltip>
  );
}
