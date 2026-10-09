import { Input, Text, useComputedColorScheme, useMantineTheme } from '@mantine/core';
import type { DropzoneProps } from '@mantine/dropzone';
import { Dropzone } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import dayjs from '~/shared/utils/dayjs';
import type { DragEvent } from 'react';
import { useState } from 'react';
import { UnreadablePickAlert } from '~/components/ImageUpload/UnreadablePickAlert';
import { useMediaUploadSettingsContext } from '~/components/MediaUploadSettings/MediaUploadSettingsProvider';
import { constants, isOrchestratorUrl } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, MIME_TYPES, VIDEO_MIME_TYPE } from '~/shared/constants/mime-types';
import { mediaDropzoneData } from '~/store/post-image-transmitter.store';
import { fetchBlob } from '~/utils/file-utils';
import { formatBytes } from '~/utils/number-helpers';
import { isAndroidDevice } from '~/utils/device-helpers';
import { reportApplicationError } from '~/utils/application-error';
import { boundedFileFields, markInMemory, splitUnreadablePicks } from '~/utils/unreadable-pick';

/** Bounded fields only: the picked file's type (from a short list), size bucket, and platform. */
function reportUnreadablePick(file: File) {
  const { type, size } = boundedFileFields(file);
  void reportApplicationError(new Error('media pick failed: pick-unreadable'), {
    name: 'media-pick',
    message: `picked-file ${type} ${size} NotReadableError android:${isAndroidDevice()}`,
    resolveStack: false,
  });
}

export function MediaDropzone({
  label,
  description,
  accept = IMAGE_MIME_TYPE,
  onDrop,
  error,
  unreadablePicks = 0,
  pickLimit,
  ...dropzoneProps
}: Omit<DropzoneProps, 'children' | 'onDropCapture' | 'onDrop'> & {
  label?: string;
  description?: React.ReactNode;
  accept?: string[];
  error?: Error;
  onDrop: (args: { file: File; meta?: Record<string, unknown> }[]) => void;
  /** Dropped files the consumer could not read later on; offered the same fallback. */
  unreadablePicks?: number;
  /**
   * How many files of a pick the consumer can take. The rest are dropped before they are read, so
   * no in-memory copy is taken of a file the consumer would discard.
   */
  pickLimit?: number;
}) {
  // #region [state]
  const settings = useMediaUploadSettingsContext();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  // How many files of the last pick could not be read.
  const [unreadableCount, setUnreadableCount] = useState(0);
  // Replaces image/* and video/* with .jpg, .png, .mp4, etc.
  // zips do not show up correctly without these extra 2 "zip" files, but we don't want to show them
  const fileExtensions = accept
    .filter((t) => t !== MIME_TYPES.xZipCompressed && t !== MIME_TYPES.xZipMultipart)
    .map((type) => type.replace(/.*\//, '.'));
  const allowsVideo = VIDEO_MIME_TYPE.some((a) => accept.includes(a));
  // #endregion

  // #region [handle drop]
  const handleDropCapture = async (e: DragEvent) => {
    const url = e.dataTransfer.getData('text/uri-list');
    const result = await mediaDropzoneData.getData(url);
    if (!result) return;
    const { file, data } = result;
    // Built in memory from the url, so a failed read of it is not the picker's doing.
    onDrop([{ file: markInMemory(file), meta: data }]);
  };
  // #endregion

  const maxVideoSize = settings?.maxSize
    ? Array.isArray(settings.maxSize)
      ? settings.maxSize.find((x) => x.type === 'video')?.maxSize ??
        constants.mediaUpload.maxVideoFileSize
      : settings.maxSize
    : constants.mediaUpload.maxVideoFileSize;

  const seconds = settings?.maxVideoDuration ?? constants.mediaUpload.maxVideoDurationSeconds;
  const durationLabel =
    seconds > 60
      ? dayjs.duration(seconds, 'seconds').format(`mm [minutes (${seconds} seconds)]`)
      : `${seconds} seconds`;

  async function handleDrop(picked: File[]) {
    const files = pickLimit === undefined ? picked : picked.slice(0, Math.max(0, pickLimit));
    const { readable, unreadable } = await splitUnreadablePicks(files, {
      maxBytes: constants.mediaUpload.maxImageFileSize,
    });
    for (const { file } of unreadable) reportUnreadablePick(file);
    setUnreadableCount(unreadable.length);
    if (readable.length) onDrop(readable.map((file) => ({ file })));
  }

  // The Files chooser bypasses the dropzone's own limits: the alert refuses a file over `maxSize`,
  // and the count is applied here.
  function handleFallbackFiles(files: File[]) {
    const { maxFiles } = dropzoneProps;
    return handleDrop(maxFiles ? files.slice(0, maxFiles) : files);
  }

  // #region [render]
  return (
    <div className="flex w-full flex-col gap-1">
      <Dropzone
        {...dropzoneProps}
        onDrop={handleDrop}
        onDropCapture={handleDropCapture}
        accept={accept}
        useFsAccessApi={!isAndroidDevice()}
      >
        <div className="flex flex-col items-center justify-center gap-2">
          <Dropzone.Accept>
            <IconUpload
              size={50}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={50}
              stroke={1.5}
              color={theme.colors.red[colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconPhoto size={50} stroke={1.5} />
          </Dropzone.Idle>
          <div className="flex flex-col items-center gap-1">
            <Text size="xl" inline>
              {label ?? 'Drag images here or click to select files'}
            </Text>
            {description}
            <Text size="sm" c="dimmed" mt={7} inline>
              {settings?.maxItems
                ? `Attach up to ${settings?.maxItems} files`
                : 'Attach as many files as you like'}
            </Text>

            {/* <Text size="sm" c="dimmed" inline>
              {`Images cannot exceed ${formatBytes(maxSize)} `}
            </Text> */}
            {allowsVideo && (
              <Text size="sm" c="dimmed" align="center" inline>
                {`Videos cannot exceed ${formatBytes(
                  maxVideoSize
                )}, 4K resolution, or ${durationLabel} in duration`}
              </Text>
            )}
            {fileExtensions.length > 0 && (
              <Text size="sm" c="blue" inline className="pt-6">
                {`Accepted file types: ${fileExtensions.join(', ')}`}
              </Text>
            )}
          </div>
        </div>
      </Dropzone>
      {unreadableCount + unreadablePicks > 0 && (
        <UnreadablePickAlert
          accept={accept}
          count={unreadableCount + unreadablePicks}
          maxSize={dropzoneProps.maxSize}
          multiple
          disabled={dropzoneProps.disabled || dropzoneProps.loading}
          onFiles={handleFallbackFiles}
        />
      )}
      {error && <Input.Error>{typeof error === 'string' ? error : error.message}</Input.Error>}
    </div>
  );
  // #endregion
}
