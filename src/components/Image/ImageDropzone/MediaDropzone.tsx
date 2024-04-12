import { Input, Text, useMantineTheme } from '@mantine/core';
import { Dropzone, DropzoneProps } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { DragEvent, useState } from 'react';
import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, MIME_TYPES, VIDEO_MIME_TYPE } from '~/server/common/mime-types';
import { fetchBlob } from '~/utils/file-utils';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { preprocessFile, PreprocessFileReturnType } from '~/utils/media-preprocessors';
import { auditMetaData } from '~/utils/metadata/audit';
import { calculateSizeInMegabytes } from '~/utils/json-helpers';
import { useCFUploadStore } from '~/store/cf-upload.store';
import { isDefined } from '~/utils/type-guards';

const MAX_IMAGE_SIZE = constants.mediaUpload.maxImageFileSize;
const MAX_VIDEO_DIMENSIONS = constants.mediaUpload.maxVideoDimension;
const MAX_VIDEO_DURATION = constants.mediaUpload.maxVideoDurationSeconds;

export function MediaDropzone({
  disabled,
  max = 10,
  count,
  label,
  description,
  accept = IMAGE_MIME_TYPE,
  maxSize = MAX_IMAGE_SIZE,
  onUploaded,
  onBlocked,
  ...dropzoneProps
}: Omit<DropzoneProps, 'children' | 'onDrop' | 'onDropCapture'> & {
  count: number;
  max?: number;
  label?: string;
  description?: React.ReactNode;
  accept?: string[];
  onUploaded: (data: MediaDropzoneCallbackProps) => void;
  onBlocked?: (data: MediaDropzoneCallbackProps) => void;
}) {
  // #region [state]
  const theme = useMantineTheme();
  const { items, upload } = useCFUploadStore();
  const [error, setError] = useState<string>();

  // Replaces image/* and video/* with .jpg, .png, .mp4, etc.
  // zips do not show up correctly without these extra 2 "zip" files, but we don't want to show them
  const fileExtensions = accept
    .filter((t) => t !== MIME_TYPES.xZipCompressed && t !== MIME_TYPES.xZipMultipart)
    .map((type) => type.replace(/.*\//, '.'));
  const allowsVideo = VIDEO_MIME_TYPE.some((a) => accept.includes(a));
  const canAdd = max - count > 0;
  // #endregion

  // #region [handle drop]
  const handleDrop = async (files: File[]) => {
    setError(undefined);

    // remove extra files that would exceed the max
    const start = count + 1;

    // remove any image files that exceed the max size
    const items = files.filter(
      (file) => !(IMAGE_MIME_TYPE.includes(file.type as IMAGE_MIME_TYPE) && file.size > maxSize)
    );
    console.log({ files, items });

    // show error notification if there are files that exceed the max size
    if (items.length !== files.length) setError(`Images should not exceed ${formatBytes(maxSize)}`);

    const sliced = items.slice(0, max - count);

    // process media metadata
    const mapped = (
      await Promise.all(
        sliced.map(async (file) => {
          try {
            const data = await preprocessFile(file);
            const processing: ProcessingFile = { ...data, file, errors: [] };
            if (data.type === 'image') {
              const { meta } = data;
              const audit = await auditMetaData(meta, false);
              if (audit.blockedFor.length) processing.blockedFor = audit.blockedFor;

              if (meta.comfy && calculateSizeInMegabytes(meta.comfy) > 1)
                processing.errors.push(
                  'Comfy metadata is too large. Please consider updating your workflow'
                );
            } else if (data.type === 'video') {
              const { metadata } = data;
              if (metadata.duration && metadata.duration > MAX_VIDEO_DURATION)
                processing.errors.push(
                  `Video duration cannot be longer than ${MAX_VIDEO_DURATION} seconds. Please trim your video and try again.`
                );
              if (metadata.width > MAX_VIDEO_DIMENSIONS || metadata.height > MAX_VIDEO_DIMENSIONS)
                processing.errors.push(
                  `Images cannot be larger than ${MAX_VIDEO_DIMENSIONS}px from either side. Please resize your image and try again.`
                );
            }
            return processing;
          } catch (error: any) {
            showErrorNotification({ error });
          }
        })
      )
    ).filter(isDefined);

    // Show unique error notifications to user
    const errors = [...new Set(mapped.filter((x) => !!x.errors.length).flatMap((x) => x.errors))];
    for (const error of errors) showErrorNotification({ error: { message: error } });

    // remove items with errors
    const filtered = mapped.filter((processing) => !processing.errors.length);

    // begin uploads
    for (const [i, { file, ...item }] of filtered.entries()) {
      const index = start + i;
      if (!!item.blockedFor?.length) {
        onBlocked?.({ ...item, index, blockedFor: item.blockedFor });
      } else {
        // upload(file, async (result) => {
        //   if (!result.success) return;
        //   onUploaded({ ...item, index, url: result.data.id });
        // });
      }
    }
  };
  // #endregion

  // #region [handle drop capture]
  const handleDropCapture = async (e: DragEvent) => {
    const url = e.dataTransfer.getData('text/uri-list');
    if (!url.startsWith('https://orchestration.civitai.com')) return;
    const blob = await fetchBlob(url);
    if (!blob) return;
    const file = new File([blob], url.substring(url.lastIndexOf('/')), { type: blob.type });
    handleDrop([file]);
  };
  // #endregion

  // #region [render]
  return (
    <div className="flex flex-col gap-1">
      <Dropzone
        {...dropzoneProps}
        disabled={!canAdd || disabled}
        onDrop={handleDrop}
        onDropCapture={handleDropCapture}
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
                {`Videos cannot exceed 4k resolution or ${constants.mediaUpload.maxVideoDurationSeconds} seconds in duration`}
              </Text>
            )}
          </div>
        </div>
      </Dropzone>
      {error && <Input.Error>{error}</Input.Error>}
    </div>
  );
  // #endregion
}

// #region [types]
type ProcessingFile = PreprocessFileReturnType & {
  file: File;
  errors: string[];
  blockedFor?: string[];
};

export type MediaDropzoneCallbackProps = PreprocessFileReturnType & {
  blockedFor?: string[];
  index: number;
  url?: string;
};
// #endregion
