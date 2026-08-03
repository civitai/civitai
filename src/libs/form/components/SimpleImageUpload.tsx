import type { InputWrapperProps } from '@mantine/core';
import { Group, Input, LoadingOverlay, Paper, Text, Tooltip } from '@mantine/core';
import type { DropzoneProps, FileWithPath } from '@mantine/dropzone';
import { Dropzone } from '@mantine/dropzone';
import { useDidUpdate } from '@mantine/hooks';
import { IconPhoto, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import type { DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

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
import { reportApplicationError } from '~/utils/application-error';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { isAndroidDevice } from '~/utils/device-helpers';

/**
 * `idle`   — nothing in flight; the current value is settled.
 * `uploading` — a drop is being processed/uploaded; the value has NOT changed yet.
 * `error`  — the last upload attempt failed; the previous value is still intact.
 */
export type SimpleImageUploadState = 'idle' | 'uploading' | 'error';

type SimpleImageUploadProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?:
    | string
    | { id?: number; nsfwLevel?: number; userId?: number; user?: { id: number }; url: string };
  onChange?: (value: DataFromFile | null) => void;
  /**
   * Opt-in upload-lifecycle signal for forms that must not submit mid-upload.
   * Purely additive — consumers that don't pass it behave exactly as before.
   */
  onUploadStateChange?: (state: SimpleImageUploadState) => void;
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
  onUploadStateChange,
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
  const [uploading, setUploading] = useState(false);

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    const hasLargeFile = droppedFiles.some((file) => file.size > maxSize);
    if (hasLargeFile) return setError(`Files should not exceed ${formatBytes(maxSize)}`);

    // 🔴 Deliberately does NOT call `handleRemove()` here.
    //
    // `handleRemove` fires `onChange(null)`, which cleared the parent form's value the
    // instant a replacement was dropped — while `onChange` only fires again once the
    // new upload reaches `status === 'success'`. A form saved mid-upload, or after a
    // failed upload, therefore persisted "no image" and destroyed the previous one.
    //
    // Only `resetFiles()` is needed to free the tracked-file slot for the new upload;
    // holding the old value until a replacement actually succeeds costs nothing and is
    // strictly safer. This path is reachable with a value present wherever the dropzone
    // stays mounted alongside one — `previewDisabled` consumers (e.g.
    // PurchasableRewardUpsertForm) and the drag-from-generator `onDropCapture`.
    resetFiles();
    setError('');
    setUploading(true);
    const [file] = droppedFiles;

    try {
      await uploadToCF(file);
    } catch (e) {
      const reason = e instanceof Error && e.message ? e.message : '';
      setError(
        reason ? `Image upload failed: ${reason}` : 'Image upload failed. Please try again.'
      );
      reportApplicationError(e, {
        name: 'SimpleImageUpload',
        message: `upload failed | file: ${file.name} (${file.type || 'unknown'}, ${file.size}b)`,
      });
    } finally {
      setUploading(false);
    }
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
      reportApplicationError(e, {
        name: 'SimpleImageUpload',
        message: `drag-from-url failed | ${url}`,
      });
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

  // Driven by the drop lifecycle rather than upload progress: a failed upload leaves
  // `progress` below 100 forever, which used to pin the overlay on permanently —
  // no preview to remove and no dropzone to retry with.
  const showLoading = uploading;

  const uploadState: SimpleImageUploadState = uploading ? 'uploading' : error ? 'error' : 'idle';
  const onUploadStateChangeRef = useRef(onUploadStateChange);
  onUploadStateChangeRef.current = onUploadStateChange;
  useEffect(() => {
    onUploadStateChangeRef.current?.(uploadState);
  }, [uploadState]);

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
