import { Input, Text, useMantineTheme } from '@mantine/core';
import { Dropzone, DropzoneProps } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { DragEvent, useState } from 'react';
import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, MIME_TYPES, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { fetchBlob } from '~/utils/file-utils';
import { formatBytes } from '~/utils/number-helpers';
import styles from './ImageDropzone.module.scss';
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
        className={`${styles.dropzone} ${disabled ? styles.dropzoneDisabled : ''} ${
          hasError || error ? styles.dropzoneError : ''
        }`}
        disabled={disabled}
        onDrop={handleDrop}
        onDropCapture={handleDropCapture}
      >
        <div className={styles.dropzoneContent}>
          <Dropzone.Accept>
            <IconUpload size={50} className={`${styles.icon} ${styles.iconAccept}`} />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX size={50} className={`${styles.icon} ${styles.iconReject}`} />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconPhoto size={50} className={`${styles.icon} ${styles.iconIdle}`} />
          </Dropzone.Idle>

          <div className={styles.textContainer}>
            <Text className={styles.title}>
              {label ?? 'Drag images here or click to select files'}
            </Text>
            {description}
            {(!max || max > 1) && (
              <Text className={styles.description}>
                {max ? `Attach up to ${max} files` : 'Attach as many files as you like'}
              </Text>
            )}
            {fileExtensions.length > 0 && (
              <Text className={styles.description}>
                {`Accepted file types: ${fileExtensions.join(', ')}`}
              </Text>
            )}
            <Text className={styles.description}>
              {`Images cannot exceed ${formatBytes(maxSize)} `}
            </Text>
            {allowsVideo && (
              <Text className={styles.description}>
                {`Videos cannot exceed ${formatBytes(
                  constants.mediaUpload.maxVideoFileSize
                )}, 4K resolution, or ${
                  constants.mediaUpload.maxVideoDurationSeconds
                } seconds in duration`}
              </Text>
            )}
          </div>
        </div>
      </Dropzone>
      {error && <Input.Error className={styles.error}>{error}</Input.Error>}
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
};

