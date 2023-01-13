import { useEffect, useRef, useState } from 'react';
import { ImageAnalysisInput } from '~/server/schema/image.schema';
import produce from 'immer';
import { FileWithPath } from '@mantine/dropzone';
import { loadImage, blurHashImage } from '~/utils/blurhash';
import { auditMetaData, getMetadata } from '~/utils/image-metadata';
import { v4 as uuidv4 } from 'uuid';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useListState } from '@mantine/hooks';

type MessageTypes =
  | { type: 'status'; status: string }
  | { type: 'error'; error: unknown; uuid?: string }
  | {
      type: 'result';
      data: {
        uuid: string;
        analysis: ImageAnalysisInput;
        nsfw: boolean;
        file: FileWithPath;
        meta: AsyncReturnType<typeof getMetadata>;
      };
    };

type ImageUpload = CustomFile;
// & {
//   uuid?: string;
//   analysis?: ImageAnalysisInput;
//   status?: 'processing' | 'uploading' | 'complete' | 'blocked' | 'error';
// };

type QueueItem = { uuid: string; file: FileWithPath };

export const useImageUpload = ({ max = 10, value }: { max?: number; value: CustomFile[] }) => {
  const workerRef = useRef<SharedWorker>();

  const [canUpload, setCanUpload] = useState(false);
  const [files, filesHandler] = useListState<ImageUpload>(value);
  const { uploadToCF } = useCFImageUpload();

  const startProcessing = async (filesToProcess: FileWithPath[]) => {
    // start processing and handle `max`
    const toProcess = await Promise.all(
      filesToProcess.slice(0, max - files.length).map(async (file) => {
        const src = URL.createObjectURL(file);
        const meta = await getMetadata(file);
        const img = await loadImage(src);
        const hashResult = blurHashImage(img);
        return {
          name: file.name,
          url: src,
          previewUrl: src,
          file,
          meta,
          uuid: uuidv4(),
          status: 'processing' as const,
          ...hashResult,
        };
      })
    );
    filesHandler.setState((files) => [...files, ...toProcess]);
    workerRef.current?.port.postMessage(
      toProcess.map(({ uuid, file, meta }) => ({ uuid, file, meta }))
    );
  };

  // #region [nsfw.worker]
  useEffect(() => {
    workerRef.current = new SharedWorker(new URL('/src/workers/nsfw.worker.ts', import.meta.url), {
      name: 'tom_bot',
    });
    workerRef.current.port.onmessage = async function ({ data: result }: { data: MessageTypes }) {
      if (result.type === 'status') {
        setCanUpload(result.status === 'ready');
      } else if (result.type === 'error') {
        console.error(result.error);
        if (result.uuid) {
          filesHandler.setState(
            produce((state) => {
              const index = state.findIndex((x) => x.uuid === result.uuid);
              state[index].status = 'error';
            })
          );
        }
      } else if (result.type === 'result') {
        const auditResult =
          result.data.nsfw && result.data.meta ? auditMetaData(result.data.meta) : undefined;
        const status = auditResult && !auditResult?.success ? 'blocked' : 'uploading';
        // const { porn, hentai, sexy } = result.data.analysis;
        // console.log({
        //   name: result.data.file.name,
        //   analysis: result.data.analysis,
        //   score: porn + hentai + sexy * 0.5,
        //   meta: result.data.meta,
        //   status,
        // });
        filesHandler.setState(
          produce((state) => {
            const index = state.findIndex((x) => x.uuid === result.data.uuid);
            if (index > -1) {
              state[index].analysis = result.data.analysis;
              state[index].nsfw = result.data.nsfw;
              state[index].status = status;
              state[index].blockedFor = auditResult?.blockedFor;

              if (status === 'blocked') {
                state[index].file = null;
              }
            }
          })
        );
        if (status === 'uploading') {
          pending.current.push({ uuid: result.data.uuid, file: result.data.file });
          setStats((stats) => {
            return {
              ...stats,
              numPending: stats.numPending + 1,
            };
          });
        }
      }
    };
  }, []); //eslint-disable-line
  // #endregion

  // #region [upload queue]
  // https://github.com/sandinmyjoints/use-async-queue
  const concurrency = Infinity;
  const pending = useRef<QueueItem[]>([]);
  const inFlight = useRef<QueueItem[]>([]);
  const [stats, setStats] = useState({
    numPending: 0,
    numInFlight: 0,
    numDone: 0,
  });

  useEffect(() => {
    while (inFlight.current.length < concurrency && pending.current.length > 0) {
      const item = pending.current.shift();
      if (!item) break;
      inFlight.current.push(item);
      setStats((stats) => {
        return {
          ...stats,
          numPending: stats.numPending - 1,
          numInFlight: stats.numInFlight + 1,
        };
      });

      Promise.resolve(
        (async function () {
          const existingFile = files.find((x) => x.uuid === item.uuid);
          if (!existingFile) return;
          const { id } = await uploadToCF(item.file);
          filesHandler.setState(
            produce((state) => {
              const index = state.findIndex((x) => x.uuid === item.uuid);
              if (index > -1) {
                const previewUrl = state[index].previewUrl;
                if (previewUrl) state[index].onLoad = () => URL.revokeObjectURL(previewUrl);
                state[index].url = id;
                state[index].file = null;
                state[index].status = 'complete';
              }
            })
          );
        })()
      )
        .then(() => {
          inFlight.current.pop();
          setStats((stats) => {
            return {
              ...stats,
              numInFlight: stats.numInFlight - 1,
              numDone: stats.numDone + 1,
            };
          });
        })
        .catch(() => {
          inFlight.current.pop();
          setStats((stats) => {
            return {
              ...stats,
              numInFlight: stats.numInFlight - 1,
              numDone: stats.numDone + 1,
            };
          });
        });
    }
  }, [stats, concurrency]); //eslint-disable-line
  // #endregion

  const removeImage = (image: ImageUpload) => {
    if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
    filesHandler.setState((state) => [...state].filter((x) => x.url !== image.url));
  };

  // const hasErrors = files.some((x) => x.status === 'error');
  // const hasBlocked = files.some((x) => x.status === 'blocked');
  // const isCompleted = files.every(
  //   (x) => x.status === 'complete' || x.status === 'error' || x.status === 'blocked'
  // );
  // const isUploading = files.some((x) => x.status === 'uploading');
  // const isProcessing = files.some((x) => x.status === 'processing');

  return {
    files,
    filesHandler,
    removeImage,
    upload: startProcessing,
    canUpload,
    // isCompleted,
    // isUploading,
    // isProcessing,
    // hasErrors,
    // hasBlocked,
  };
};
