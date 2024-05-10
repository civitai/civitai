import { MediaType } from '@prisma/client';
import { useEffect, useRef, useState } from 'react';
import { useFileUpload } from '~/hooks/useFileUpload';
import { constants } from '~/server/common/constants';
import { MEDIA_TYPE } from '~/server/common/mime-types';
import { calculateSizeInMegabytes } from '~/utils/json-helpers';
import { PreprocessFileReturnType, preprocessFile } from '~/utils/media-preprocessors';
import { auditMetaData } from '~/utils/metadata/audit';
import { formatBytes } from '~/utils/number-helpers';

const MAX_VIDEO_DIMENSIONS = constants.mediaUpload.maxVideoDimension;
const MAX_VIDEO_DURATION = constants.mediaUpload.maxVideoDurationSeconds;

// #region [types]
type ProcessingFile = PreprocessFileReturnType & {
  file: File;
  blockedFor?: string;
};

type MediaUploadDataProps = PreprocessFileReturnType & { url: string; index: number };

export type MediaUploadOnCompleteProps = {
  status: 'added' | 'blocked' | 'error';
  blockedFor?: string | null;
} & MediaUploadDataProps;

export type MediaUploadMaxSizeByType = { type: MediaType; maxSize: number }[];

export type UseMediaUploadProps<TContext> = {
  count: number;
  max: number;
  maxSize?: number | MediaUploadMaxSizeByType;
  onComplete: (props: MediaUploadOnCompleteProps, context?: TContext) => void;
};
// #endregion

export function useMediaUpload<TContext extends Record<string, unknown>>({
  max,
  count,
  maxSize,
  onComplete,
}: UseMediaUploadProps<TContext>) {
  // #region [state]
  const [error, setError] = useState<Error>();
  const { files, upload, reset, removeFile } = useFileUpload();
  const canAdd =
    max - count > 0 && !files.some((x) => x.status === 'uploading' || x.status === 'pending');
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  // #endregion

  // #region [file processor]
  async function processFiles(files: File[], context?: TContext) {
    try {
      const start = count + 1;

      // check for files that exceed the max size
      if (maxSize) {
        for (const file of files) {
          const mediaType = MEDIA_TYPE[file.type];
          const _maxSize = Array.isArray(maxSize)
            ? maxSize.find((x) => x.type === mediaType)?.maxSize
            : maxSize;

          if (_maxSize && file.size > _maxSize)
            throw new Error(`${mediaType} files should not exceed ${formatBytes(_maxSize)}`.trim());
        }
      }

      // remove extra files that would exceed the max
      const sliced = files.slice(0, max - count);

      // process media metadata
      const mapped = await Promise.all(
        sliced.map(async (file) => {
          const data = await preprocessFile(file);
          const processing: ProcessingFile = { ...data, file };
          if (data.type === 'image') {
            const { meta } = data;
            const audit = await auditMetaData(meta, false);
            if (audit.blockedFor.length) processing.blockedFor = audit.blockedFor.join(',');

            if (meta.comfy && calculateSizeInMegabytes(meta.comfy) > 1)
              throw new Error(
                'Comfy metadata is too large. Please consider updating your workflow'
              );
          } else if (data.type === 'video') {
            const { metadata } = data;
            if (metadata.duration && metadata.duration > MAX_VIDEO_DURATION)
              throw new Error(
                `Video duration cannot be longer than ${MAX_VIDEO_DURATION} seconds. Please trim your video and try again.`
              );
            if (metadata.width > MAX_VIDEO_DIMENSIONS || metadata.height > MAX_VIDEO_DIMENSIONS)
              throw new Error(
                `Videos cannot be larger than ${MAX_VIDEO_DIMENSIONS}px from either side. Please resize your image and try again.`
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
          upload(file)
            .then(({ id }) => {
              onComplete({ status: 'added', ...data, url: id, index }, context);
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
          removeFile(file.url);
        }
      }, 3000);
    } else clearTimeout(timeoutRef.current);
  }, [files]); // eslint-disable-line
  // #endregion

  return { canAdd, upload: processFiles, error, files, progress, reset, removeFile };
}
