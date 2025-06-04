import { Input, Text, useMantineTheme } from '@mantine/core';
import type { DropzoneProps } from '@mantine/dropzone';
import { Dropzone } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import type { DragEvent } from 'react';
import { useState } from 'react';
import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, MIME_TYPES, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { fetchBlob } from '~/utils/file-utils';
import { formatBytes } from '~/utils/number-helpers';
import clsx from 'clsx';
import { isOrchestratorUrl } from '~/server/common/constants';

export function ImageDropzone({
  disabled: initialDisabled,
  max = 10,
  hasError,
  onDrop,
  count,
  label,
  description,
  accept = IMAGE_MIME_TYPE,
  maxSize = constants.mediaUpload.maxImageFileSize,
  onExceedMax,
  allowExternalImageDrop,
  onDropCapture,
  children,
  iconSize = 50,
  ...props
}: Props) {
  const theme = useMantineTheme();
  const [error, setError] = useState('');

  const canAddFiles = max - count > 0;
  const disabled = !canAddFiles || initialDisabled;
  // Replaces image/* and video/* with .jpg, .png, .mp4, etc.
  // zips do not show up correctly without these extra 2 "zip" files, but we don't want to show them
  const fileExtensions = accept
    .filter((t) => t !== MIME_TYPES.xZipCompressed && t !== MIME_TYPES.xZipMultipart)
    .map((type) => type.replace(/.*\//, '.'));
  const allowsVideo = VIDEO_MIME_TYPE.some((a) => accept.includes(a));

  const handleDrop = (files: File[]) => {
    const hasLargeImageFiles = files.some(
      (file) => IMAGE_MIME_TYPE.includes(file.type as IMAGE_MIME_TYPE) && file.size > maxSize
    );
    if (hasLargeImageFiles) return setError(`Images should not exceed ${formatBytes(maxSize)}`);

    setError('');

    if (!!onExceedMax && files.length > max - count) {
      onExceedMax();
    }

    onDrop?.(files.slice(0, max - count));
  };

  const handleDropCapture = async (e: DragEvent) => {
    const url = e.dataTransfer.getData('text/uri-list');
    if (!url.length || (!allowExternalImageDrop && !isOrchestratorUrl(url))) return;
    onDropCapture ? onDropCapture(url) : handleDropCaptureUrl(url);
  };

  async function handleDropCaptureUrl(url: string) {
    const blob = await fetchBlob(url);
    if (!blob) return;
    const file = new File([blob], url.substring(url.lastIndexOf('/')), { type: blob.type });
    handleDrop([file]);
  }

  return (
    <>
      <Dropzone
        {...props}
        accept={accept}
        className={clsx({
          ['bg-gray-0 dark:bg-dark-6 border-gray-2 dark:border-dark-5 cursor-not-allowed [&_*]:text-gray-5 [&_*]:dark:text-dark-3']:
            disabled,
        })}
        classNames={{
          root: clsx('flex size-full items-center justify-center', {
            ['border-red-6 mb-1']: hasError || !!error,
          }),
        }}
        disabled={!canAddFiles || disabled}
        onDrop={handleDrop}
        onDropCapture={handleDropCapture}
      >
        <div className="pointer-events-none flex min-h-28 flex-col items-center justify-center gap-2">
          <Dropzone.Accept>
            <IconUpload
              size={iconSize}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][theme.colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={iconSize}
              stroke={1.5}
              color={theme.colors.red[theme.colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconPhoto size={iconSize} stroke={1.5} />
          </Dropzone.Idle>

          {children ?? (
            <div className="flex flex-col items-center gap-1">
              <Text size="xl" inline align="center">
                {label ?? 'Drag images here or click to select files'}
              </Text>
              {description}
              {(!max || max > 1) && (
                <Text size="sm" color="dimmed" mt={7} inline>
                  {max ? `Attach up to ${max} files` : 'Attach as many files as you like'}
                </Text>
              )}
              {fileExtensions.length > 0 && (
                <Text size="sm" color="dimmed" inline>
                  {`Accepted file types: ${fileExtensions.join(', ')}`}
                </Text>
              )}
              <Text size="sm" color="dimmed" inline>
                {`Images cannot exceed ${formatBytes(maxSize)} `}
              </Text>
              {allowsVideo && (
                <Text size="sm" color="dimmed" inline>
                  {`Videos cannot exceed ${formatBytes(
                    constants.mediaUpload.maxVideoFileSize
                  )}, 4K resolution, or ${
                    constants.mediaUpload.maxVideoDurationSeconds
                  } seconds in duration`}
                </Text>
              )}
            </div>
          )}
        </div>
      </Dropzone>
      {error && <Input.Error className="mt-1">{error}</Input.Error>}
    </>
  );
}

type Props = Omit<DropzoneProps, 'children' | 'onDropCapture'> & {
  count: number;
  max?: number;
  hasError?: boolean;
  label?: string;
  description?: React.ReactNode;
  accept?: string[];
  onExceedMax?: () => void;
  allowExternalImageDrop?: boolean;
  onDropCapture?: (url: string) => void;
  children?: React.ReactNode;
  iconSize?: number;
};
