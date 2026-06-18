import type { InputWrapperProps } from '@mantine/core';
import { Group, Input, LoadingOverlay, Paper, Text, Tooltip } from '@mantine/core';
import type { DropzoneProps, FileWithPath } from '@mantine/dropzone';
import { Dropzone } from '@mantine/dropzone';
import { useDidUpdate } from '@mantine/hooks';
import { IconPhoto, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import type { DragEvent } from 'react';
import { useEffect, useState } from 'react';

import classes from './SimpleImageUpload.module.scss';

import { MediaType } from '~/shared/utils/prisma/enums';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { BrowsingLevelBadge } from '~/components/BrowsingLevel/BrowsingLevelBadge';
import type { DataFromFile } from '~/hooks/useCFImageUpload';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants, isOrchestratorUrl } from '~/server/common/constants';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { fetchBlob } from '~/utils/file-utils';
import { formatBytes } from '~/utils/number-helpers';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { isAndroidDevice } from '~/utils/device-helpers';

type SimpleImageUploadProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?:
    | string
    | { id?: number; nsfwLevel?: number; userId?: number; user?: { id: number }; url: string };
  onChange?: (value: DataFromFile | null) => void;
  previewWidth?: number;
  maxSize?: number;
  aspectRatio?: number;
  children?: React.ReactNode;
  dropzoneProps?: Omit<DropzoneProps, 'children' | 'onDrop'>;
  previewDisabled?: boolean;
  withNsfwLevel?: boolean;
  disabled?: boolean;
};

export function SimpleImageUpload({
  value,
  onChange,
  maxSize = constants.mediaUpload.maxImageFileSize,
  previewWidth = 450,
  aspectRatio,
  children,
  previewDisabled,
  dropzoneProps,
  withNsfwLevel = true,
  disabled,
  ...props
}: SimpleImageUploadProps) {
  const { uploadToCF, files: imageFiles, resetFiles } = useCFImageUpload();
  const imageFile = imageFiles[0];
  // const [files, filesHandlers] = useListState<CustomFile>(value ? [{ url: value }] : []);
  const [image, setImage] = useState<{ url: string; objectUrl?: string } | undefined>();

  const [error, setError] = useState('');

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    const hasLargeFile = droppedFiles.some((file) => file.size > maxSize);
    if (hasLargeFile) return setError(`Files should not exceed ${formatBytes(maxSize)}`);

    handleRemove();
    setError('');
    const [file] = droppedFiles;

    // const toUpload = { url: URL.createObjectURL(file), file };
    // setImage((current) => ({
    //   ...current,
    //   previewUrl: toUpload.url,
    //   url: '',
    //   file: toUpload.file,
    // }));

    await uploadToCF(file);
    // setImage((current) => ({ ...current, url: id, file: undefined, previewUrl: undefined }));
    // URL.revokeObjectURL(objectUrl);
  };

  // Handles drags from the generator, which arrive as a `text/uri-list` orchestrator URL rather
  // than a file. We fetch the URL into a File and reuse handleDrop. Only orchestrator URLs are
  // accepted — arbitrary external URLs are ignored (cross-origin CORS blocks client-side fetch).
  // fetchBlob still rejects on transient network failures, so the fetch is wrapped to surface a
  // friendly error instead of an unhandled rejection.
  const handleDropCapture = async (e: DragEvent) => {
    const url = e.dataTransfer.getData('text/uri-list');
    if (!url.length || !isOrchestratorUrl(url)) return;
    setError('');
    try {
      const blob = await fetchBlob(url);
      if (!blob) throw new Error('Empty image');
      // Strip the leading slash and signed query string so the upload gets a clean filename.
      const filename = url.substring(url.lastIndexOf('/') + 1).split('?')[0];
      const file = new File([blob], filename, { type: blob.type });
      await handleDrop([file as FileWithPath]);
    } catch (e) {
      console.error('Failed to load dropped image', e);
      setError("Couldn't load that image. Try saving it and uploading the file instead.");
    }
  };

  const handleRemove = () => {
    setImage(undefined);
    onChange?.(null);
    resetFiles();
  };

  useEffect(() => {
    const newValue =
      typeof value === 'string' ? (value.length > 0 ? { url: value } : undefined) : value;

    if (!isEqual(image, newValue))
      setImage(typeof value === 'string' ? (value.length > 0 ? { url: value } : undefined) : value);
  }, [image, value]);

  useDidUpdate(() => {
    if (!imageFile) return;
    setImage({ url: imageFile.url, objectUrl: imageFile.objectUrl });

    if (imageFile.status === 'success') {
      onChange?.(imageFile);
    }
    // don't disable the eslint-disable
  }, [imageFile]); // eslint-disable-line

  const [match] = imageFiles;
  const showLoading = match && match.progress < 100;

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      {showLoading ? (
        <Paper
          style={{ position: 'relative', marginTop: 5, width: '100%', height: 200 }}
          withBorder
        >
          <LoadingOverlay visible />
        </Paper>
      ) : !previewDisabled && image ? (
        <div style={{ position: 'relative', width: '100%', marginTop: 5 }}>
          {!disabled && (
            <Tooltip label="Remove image">
              <LegacyActionIcon
                size="sm"
                variant={aspectRatio ? 'filled' : 'light'}
                color="red"
                onClick={handleRemove}
                className="absolute right-1 top-1 z-[1]"
              >
                <IconTrash />
              </LegacyActionIcon>
            </Tooltip>
          )}

          <div
            style={
              aspectRatio
                ? ({
                    '--aspect-ratio': `${(aspectRatio * 100).toFixed(3)}%`,
                  } as React.CSSProperties)
                : undefined
            }
            className={aspectRatio ? classes.imageContainerAspectRatio : classes.imageContainer}
          >
            {withNsfwLevel && !!value && typeof value !== 'string' && (
              <BrowsingLevelBadge
                browsingLevel={value.nsfwLevel}
                className="absolute left-2 top-2 z-10"
              />
            )}
            <EdgeMedia
              src={image.objectUrl ?? image.url}
              type={MediaType.image}
              width={previewWidth}
              style={{ maxWidth: aspectRatio ? '100%' : undefined }}
              anim
            />
          </div>
        </div>
      ) : (
        <Dropzone
          mt={5}
          classNames={{
            root: props.error || error ? 'border-red-6 mb-[5px]' : undefined,
          }}
          accept={IMAGE_MIME_TYPE}
          {...dropzoneProps}
          onDrop={handleDrop}
          onDropCapture={handleDropCapture}
          maxFiles={1}
          disabled={disabled}
          useFsAccessApi={!isAndroidDevice()}
          // maxSize={maxSize}
        >
          <Dropzone.Accept>
            <Group justify="center" gap="xs">
              <IconUpload size={32} stroke={1.5} className="text-blue-6 dark:text-blue-4" />
              <Text c="dimmed">Drop image here</Text>
            </Group>
          </Dropzone.Accept>
          <Dropzone.Reject>
            <Group justify="center" gap="xs">
              <IconX size={32} stroke={1.5} className="text-red-6 dark:text-red-4" />
              <Text>File not accepted</Text>
            </Group>
          </Dropzone.Reject>
          <Dropzone.Idle>
            <Group justify="center" gap="xs">
              <IconPhoto size={32} stroke={1.5} />
              <Text c="dimmed">{`Drop image here, should not exceed ${formatBytes(maxSize)}`}</Text>
            </Group>
          </Dropzone.Idle>
        </Dropzone>
      )}
      {children}
    </Input.Wrapper>
  );
}
