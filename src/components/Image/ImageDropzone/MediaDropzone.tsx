import { Input, Text, useMantineTheme } from '@mantine/core';
import { Dropzone, DropzoneProps } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import dayjs from 'dayjs';
import { DragEvent } from 'react';
import { useMediaUploadSettingsContext } from '~/components/MediaUploadSettings/MediaUploadSettingsProvider';
import { constants, isOrchestratorUrl } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, MIME_TYPES, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { mediaDropzoneData } from '~/store/post-image-transmitter.store';
import { fetchBlob } from '~/utils/file-utils';
import { formatBytes } from '~/utils/number-helpers';

export function MediaDropzone({
  label,
  description,
  accept = IMAGE_MIME_TYPE,
  onDrop,
  error,
  ...dropzoneProps
}: Omit<DropzoneProps, 'children' | 'onDropCapture' | 'onDrop'> & {
  label?: string;
  description?: React.ReactNode;
  accept?: string[];
  error?: Error;
  onDrop: (args: { file: File; meta?: Record<string, unknown> }[]) => void;
}) {
  // #region [state]
  const settings = useMediaUploadSettingsContext();
  const theme = useMantineTheme();
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
    onDrop([{ file, meta: data }]);
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

  function handleDrop(files: File[]) {
    onDrop(files.map((file) => ({ file })));
  }

  // #region [render]
  return (
    <div className="flex w-full flex-col gap-1">
      <Dropzone
        {...dropzoneProps}
        onDrop={handleDrop}
        onDropCapture={handleDropCapture}
        accept={accept}
      >
        <div className="flex flex-col items-center justify-center gap-2">
          <Dropzone.Accept>
            <IconUpload
              size={50}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][theme.colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={50}
              stroke={1.5}
              color={theme.colors.red[theme.colorScheme === 'dark' ? 4 : 6]}
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
            <Text size="sm" color="dimmed" mt={7} inline>
              {settings?.maxItems
                ? `Attach up to ${settings?.maxItems} files`
                : 'Attach as many files as you like'}
            </Text>

            {/* <Text size="sm" color="dimmed" inline>
              {`Images cannot exceed ${formatBytes(maxSize)} `}
            </Text> */}
            {allowsVideo && (
              <Text size="sm" color="dimmed" align="center" inline>
                {`Videos cannot exceed ${formatBytes(
                  maxVideoSize
                )}, 4K resolution, or ${durationLabel} in duration`}
              </Text>
            )}
            {fileExtensions.length > 0 && (
              <Text size="sm" color="blue" inline className="pt-6">
                {`Accepted file types: ${fileExtensions.join(', ')}`}
              </Text>
            )}
          </div>
        </div>
      </Dropzone>
      {error && <Input.Error>{error.message}</Input.Error>}
    </div>
  );
  // #endregion
}
