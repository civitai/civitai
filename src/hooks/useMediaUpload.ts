import { useEffect, useRef, useState } from 'react';
import { useMediaUploadSettingsContext } from '~/components/MediaUploadSettings/MediaUploadSettingsProvider';
import { useS3Upload } from '~/hooks/useS3Upload';
import { UploadType } from '~/server/common/enums';
import { MEDIA_TYPE } from '~/server/common/mime-types';
import { calculateSizeInMegabytes } from '~/utils/json-helpers';
import { preprocessFile, PreprocessFileReturnType } from '~/utils/media-preprocessors';
import { auditMetaData } from '~/utils/metadata/audit';
import { formatBytes } from '~/utils/number-helpers';

// #region [types]
type ProcessingFile = PreprocessFileReturnType & {
  file: File;
  blockedFor?: string;
  meta?: Record<string, unknown>;
};

type MediaUploadDataProps = PreprocessFileReturnType & { url: string; index: number };

export type MediaUploadOnCompleteProps = {
  status: 'added' | 'blocked' | 'error';
  blockedFor?: string | null;
} & MediaUploadDataProps;

export type UseMediaUploadProps<TContext> = {
  count: number;
  onComplete: (props: MediaUploadOnCompleteProps, context?: TContext) => void;
};

// #endregion

export function useMediaUpload<TContext extends Record<string, unknown>>({
  count,
  onComplete,
}: UseMediaUploadProps<TContext>) {
  // #region [state]
  const [error, setError] = useState<Error>();
  const {
    files,
    uploadToS3: upload,
    resetFiles: reset,
    removeFile,
  } = useS3Upload({
    endpoint: '/api/v1/image-upload/multipart',
  });
  const uploadSettings = useMediaUploadSettingsContext();
  const canAdd =
    uploadSettings.maxItems - count > 0 &&
    !files.some((x) => x.status === 'uploading' || x.status === 'pending');
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  // #endregion

  // #region [file processor]
  async function processFiles(
    data: { file: File; meta?: Record<string, unknown> }[],
    context?: TContext
  ) {
    try {
      const start = count + 1;
      const { maxSize } = uploadSettings;
      // check for files that exceed the max size
      if (maxSize) {
        for (const { file } of data) {
          const mediaType = MEDIA_TYPE[file.type];
          const _maxSize = Array.isArray(maxSize)
            ? maxSize.find((x) => x.type === mediaType)?.maxSize
            : maxSize;

          if (_maxSize && file.size > _maxSize)
            throw new Error(`${mediaType} files should not exceed ${formatBytes(_maxSize)}`.trim());
        }
      }

      // remove extra files that would exceed the max
      const sliced = data.slice(0, uploadSettings.maxItems - count);

      // process media metadata
      const mapped = await Promise.all(
        sliced.map(async ({ file, meta: fileMeta }) => {
          const data = await preprocessFile(file);
          const processing: ProcessingFile = { ...data, meta: { ...fileMeta, ...data.meta }, file };
          const { meta } = data;

          if (meta) {
            const audit = await auditMetaData(meta, false);
            if (audit.blockedFor.length) processing.blockedFor = audit.blockedFor.join(',');
          }

          if (data.type === 'image') {
            if (meta?.comfy && calculateSizeInMegabytes(meta.comfy) > 1)
              throw new Error(
                'Comfy metadata is too large. Please consider updating your workflow'
              );
          } else if (data.type === 'video') {
            const { metadata } = data;
            if (metadata.duration && metadata.duration > uploadSettings.maxVideoDuration)
              throw new Error(
                `Video duration cannot be longer than ${uploadSettings.maxVideoDuration} seconds. Please trim your video and try again.`
              );
            if (
              metadata.width > uploadSettings.maxVideoDimensions ||
              metadata.height > uploadSettings.maxVideoDimensions
            )
              throw new Error(
                `Videos cannot be larger than ${uploadSettings.maxVideoDimensions}px from either side. Please resize your image or video and try again.`
              );
          }
          return processing;
        })
      );

      setError(undefined);

      // begin uploads
      const onComplete = onCompleteRef.current;
      for (const [i, { file, ...data }] of mapped.entries()) {
        const index = start + i;
        if (!!data.blockedFor) {
          onComplete?.(
            {
              status: 'blocked',
              ...data,
              url: data.objectUrl,
              index,
            },
            context
          );
        } else {
          upload(file, UploadType.Image)
            .then(({ key, url }) => {
              if (!url) {
                throw new Error('Failed to upload image');
              }

              onComplete({ status: 'added', ...data, url: key, index }, context);
            })
            .catch((error) => {
              console.error(error);
              onComplete({ status: 'error', ...data, url: data.objectUrl, index }, context);
            });
        }
      }
    } catch (error: any) {
      setError(error);
    }
  }
  // #endregion

  // #region [progress]
  const progress = files.reduce((acc, value) => (acc += value.progress), 0) / files.length;
  const timeoutRef = useRef<NodeJS.Timeout>();
  useEffect(() => {
    if (!files.length) return;
    if (files.every((file) => file.progress === 100)) {
      timeoutRef.current = setTimeout(() => {
        for (const file of files) {
          removeFile(file.file);
        }
      }, 3000);
    } else clearTimeout(timeoutRef.current);
  }, [files]); // eslint-disable-line
  // #endregion

  return { canAdd, upload: processFiles, error, files, progress, reset, removeFile };
}
