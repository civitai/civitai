import { FileWithPath } from '@mantine/dropzone';
import { useListState } from '@mantine/hooks';
import produce from 'immer';
import { useEffect, useRef, useState } from 'react';

import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { useImageProcessingContext } from '~/components/ImageProcessing';

type ImageUpload = CustomFile;

type QueueItem = { uuid: string; file: FileWithPath };

export const useImageUpload = ({ max = 10, value }: { max?: number; value: CustomFile[] }) => {
  const { scanImages, canUseScanner } = useImageProcessingContext();

  // const [canUpload, setCanUpload] = useState(!supportsWebWorker);
  const [files, filesHandler] = useListState<ImageUpload>(value);
  const { uploadToCF } = useCFImageUpload();

  const startProcessing = async (filesToProcess: File[]) => {
    scanImages(filesToProcess.slice(0, max - files.length), (data) => {
      console.log({ data });
      switch (data.type) {
        case 'error':
          filesHandler.setState(
            produce((state) => {
              const index = state.findIndex((x) => x.uuid === payload.uuid);
              if (!index) throw new Error('missing index');
              state[index].status = 'error';
            })
          );
          break;
        case 'processing': // this would be better if we split it into separate events
          const { payload } = data;
          let status = 'processing';
          if (payload.blockedFor) status = 'blocked';
          else if (payload.status === 'finished') status = 'uploading';

          filesHandler.setState(
            produce((state) => {
              const index = state.findIndex((x) => x.uuid === payload.uuid);
              const data = {
                ...payload,
                status,
                url: payload.src,
                previewUrl: payload.src,
                file: status !== 'blocked' ? payload.file : undefined,
              } as CustomFile;

              if (index === -1) state.push(data);
              state[index] = data;
            })
          );
          if (status === 'uploading') {
            pending.current.push({ uuid: payload.uuid, file: payload.file });
            setStats((stats) => {
              return {
                ...stats,
                numPending: stats.numPending + 1,
              };
            });
          }
          break;
        default:
          throw new Error('unhandled scan event type');
      }
    });
  };

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
                state[index].file = undefined;
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
    canUpload: true,
    canUseScanner,
    // isCompleted,
    // isUploading,
    // isProcessing,
    // hasErrors,
    // hasBlocked,
  };
};
