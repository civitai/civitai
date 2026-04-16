import { useEffect, useRef, useState } from 'react';
import { useFileUploadContext } from '~/components/FileUpload/FileUploadProvider';
import { useMediaUploadSettingsContext } from '~/components/MediaUploadSettings/MediaUploadSettingsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useS3Upload } from '~/hooks/useS3Upload';
import { UploadType } from '~/server/common/enums';
import { MEDIA_TYPE } from '~/shared/constants/mime-types';
import { calculateSizeInMegabytes } from '~/utils/json-helpers';
import type { PreprocessFileReturnType } from '~/utils/media-preprocessors';
import { preprocessFile } from '~/utils/media-preprocessors';
import { auditMetaData } from '~/utils/metadata/audit';
import { showErrorNotification } from '~/utils/notifications';
import { formatBytes } from '~/utils/number-helpers';
import { isDefined } from '~/utils/type-guards';

// Max number of images uploading concurrently to S3. Tune here if we hit
// throttling from the bucket or want to let more through.
const MAX_CONCURRENT_UPLOADS = 2;

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
  const currentUser = useCurrentUser();
  // #region [state]
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(false);
  const {
    files,
    uploadToS3: upload,
    resetFiles: reset,
    removeFile,
  } = useS3Upload({
    endpoint: '/api/v1/image-upload/multipart',
  });
  const fileUploadContext = useFileUploadContext();
  const uploadSettings = useMediaUploadSettingsContext();
  const canAdd =
    uploadSettings.maxItems - count > 0 &&
    !files.some((x) => x.status === 'uploading' || x.status === 'pending');
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // Concurrency pool shared across all processFiles() calls on this hook instance.
  type UploadJob = {
    processing: ProcessingFile;
    index: number;
    context?: TContext;
    aborted: boolean;
  };
  const activeWorkersRef = useRef(0);
  const jobQueueRef = useRef<UploadJob[]>([]);

  async function runWorker() {
    try {
      while (jobQueueRef.current.length > 0) {
        const job = jobQueueRef.current.shift()!;
        if (job.aborted) continue;
        const onComplete = onCompleteRef.current;
        const { file, ...data } = job.processing;
        try {
          const { key, url } = await upload(file, UploadType.Image);
          if (!url) throw new Error('Failed to upload image');
          onComplete({ status: 'added', ...data, url: key, index: job.index }, job.context);
        } catch (e) {
          console.error(e);
          onComplete(
            { status: 'error', ...data, url: data.objectUrl, index: job.index },
            job.context
          );
        }
      }
    } finally {
      activeWorkersRef.current--;
    }
  }

  function enqueueJobs(jobs: UploadJob[]) {
    if (!jobs.length) return;

    // Dedupe against anything currently queued or already uploading.
    // Guards against accidental double-enqueue (rapid re-drops, effect re-fires,
    // consumer bugs) that would otherwise result in the same File being uploaded
    // twice and creating duplicate image records on the server.
    const inFlight = new Set<File>();
    for (const queued of jobQueueRef.current) inFlight.add(queued.processing.file);
    if (fileUploadContext) {
      const [existing] = fileUploadContext;
      for (const tracked of existing) {
        if (tracked.status === 'pending' || tracked.status === 'uploading') {
          inFlight.add(tracked.file);
        }
      }
    }
    const uniqueJobs = jobs.filter((j) => !inFlight.has(j.processing.file));
    if (!uniqueJobs.length) return;

    // Pre-register pending entries so the UI reflects queued items.
    if (fileUploadContext) {
      const [, setFiles] = fileUploadContext;
      setFiles((prev) => {
        const existing = new Set(prev.map((x) => x.file));
        const additions = uniqueJobs
          .filter((job) => !existing.has(job.processing.file))
          .map((job) => ({
            file: job.processing.file,
            progress: 0,
            uploaded: 0,
            size: job.processing.file.size,
            speed: 0,
            timeRemaining: 0,
            status: 'pending' as const,
            abort: () => {
              job.aborted = true;
              // Drop the tracked pending entry so canAdd frees up and the UI
              // doesn't show a phantom "pending" row for a file we'll never upload.
              setFiles((cur) => cur.filter((x) => x.file !== job.processing.file));
            },
            name: job.processing.file.name,
            url: '',
          }));
        return additions.length ? [...prev, ...additions] : prev;
      });
    }

    jobQueueRef.current.push(...uniqueJobs);
    while (activeWorkersRef.current < MAX_CONCURRENT_UPLOADS && jobQueueRef.current.length > 0) {
      activeWorkersRef.current++;
      runWorker().catch((e) => {
        // Safety net — runWorker has a finally for bookkeeping, but if something
        // truly unexpected escapes, we must not swallow it silently.
        console.error('runWorker unexpectedly threw', e);
      });
    }
  }
  // #endregion

  // #region [file processor]
  async function processFiles(
    data: { file: File; meta?: Record<string, unknown> }[],
    context?: TContext
  ) {
    setLoading(true);
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
      const mapped = (
        await Promise.all(
          sliced.map(async ({ file, meta: fileMeta }) => {
            let data: PreprocessFileReturnType | null;
            try {
              data = await preprocessFile(file, { allowAnimatedWebP: currentUser?.isModerator });
            } catch (e: any) {
              data = null;
              showErrorNotification({
                title: `Error: ${file.name}`,
                error: e instanceof Error ? e : { message: e },
                autoClose: 6000,
              });
            }
            if (!data) return null;
            // Merge civitaiResources arrays by modelVersionId instead of overwriting
            const mergedCivitaiResources = (() => {
              const fileResources = fileMeta?.civitaiResources as
                | { modelVersionId: number }[]
                | undefined;
              const exifResources = data.meta?.civitaiResources as
                | { modelVersionId: number }[]
                | undefined;
              if (!fileResources?.length) return exifResources;
              if (!exifResources?.length) return fileResources;
              const merged = [...fileResources];
              for (const resource of exifResources) {
                if (!merged.some((r) => r.modelVersionId === resource.modelVersionId)) {
                  merged.push(resource);
                }
              }
              return merged;
            })();
            const processing: ProcessingFile = {
              ...data,
              meta: {
                ...fileMeta,
                ...data.meta,
                ...(mergedCivitaiResources ? { civitaiResources: mergedCivitaiResources } : {}),
              },
              file,
            };
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
        )
      ).filter(isDefined);

      setError(undefined);

      // begin uploads
      const jobs: UploadJob[] = [];
      for (const [i, processing] of mapped.entries()) {
        const index = start + i;
        if (!!processing.blockedFor) {
          const { file, ...data } = processing;
          onCompleteRef.current?.(
            {
              status: 'blocked',
              ...data,
              url: data.objectUrl,
              index,
            },
            context
          );
        } else {
          jobs.push({ processing, index, context, aborted: false });
        }
      }
      enqueueJobs(jobs);
    } catch (error: any) {
      setError(error);
    }
    setLoading(false);
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

  return { canAdd, upload: processFiles, error, files, progress, reset, removeFile, loading };
}
