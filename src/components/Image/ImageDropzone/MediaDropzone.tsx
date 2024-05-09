import { Input, Text, useMantineTheme } from '@mantine/core';
import { Dropzone, DropzoneProps } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { DragEvent } from 'react';
import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, MIME_TYPES, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { fetchBlob } from '~/utils/file-utils';

const MAX_IMAGE_SIZE = constants.mediaUpload.maxImageFileSize;

export function MediaDropzone({
  label,
  description,
  accept = IMAGE_MIME_TYPE,
  onDrop,
  error,
  max,
  ...dropzoneProps
}: Omit<DropzoneProps, 'children' | 'onDropCapture'> & {
  label?: string;
  description?: React.ReactNode;
  accept?: string[];
  error?: Error;
  max?: number;
}) {
  // #region [state]
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
    if (
      !(
        url.startsWith('https://orchestration.civitai.com') ||
        url.startsWith('https://orchestration-stage.civitai.com')
      )
    )
      return;
    const blob = await fetchBlob(url);
    if (!blob) return;
    const file = new File([blob], url.substring(url.lastIndexOf('/')), { type: blob.type });
    onDrop([file]);
  };
  // #endregion

  // #region [render]
  return (
    <div className="flex flex-col w-full gap-1">
      <Dropzone
        {...dropzoneProps}
        onDrop={onDrop}
        onDropCapture={handleDropCapture}
        accept={accept}
      >
        <div className="flex flex-col justify-center items-center gap-2">
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
          <div className="flex flex-col gap-1 items-center">
            <Text size="xl" inline>
              {label ?? 'Drag images here or click to select files'}
            </Text>
            {description}
            <Text size="sm" color="dimmed" mt={7} inline>
              {max ? `Attach up to ${max} files` : 'Attach as many files as you like'}
            </Text>

            {/* <Text size="sm" color="dimmed" inline>
              {`Images cannot exceed ${formatBytes(maxSize)} `}
            </Text> */}
            {allowsVideo && (
              <Text size="sm" color="dimmed" inline>
                {`Videos cannot exceed 4k resolution or ${constants.mediaUpload.maxVideoDurationSeconds} seconds in duration`}
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
