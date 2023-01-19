import { FileWithPath } from '@mantine/dropzone';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { ImageAnalysisInput } from '~/server/schema/image.schema';
import { getMetadata } from '~/utils/image-metadata';

type MessageTypes =
  | { type: 'status'; status: string }
  | {
      type: 'error';
      data: {
        error: unknown;
        uuid: string;
      };
    }
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

type MessageCallback = ({ data }: { data: MessageTypes }) => void;

type NsfwWorkerState = {
  scanImages: (
    images: {
      uuid: string;
      file: FileWithPath;
      meta: AsyncReturnType<typeof getMetadata>;
    }[],
    cb: ({ data }: { data: MessageTypes }) => void
  ) => void;
};

const NsfwWorkerCtx = createContext<NsfwWorkerState>({} as NsfwWorkerState);
const callbackQueue: Record<string, MessageCallback> = {};

export const useNsfwWorkerContext = () => useContext(NsfwWorkerCtx);
export const NsfwWorkerProvider = ({ children }: { children: React.ReactNode }) => {
  const workerRef = useRef<SharedWorker>();
  const workerPromise = useRef<Promise<SharedWorker>>();
  const noSharedWorker = typeof window === 'undefined' || !('SharedWorker' in window);
  const supportsWebWorker = !noSharedWorker;

  const getWorker = () => {
    if (workerPromise.current) return workerPromise.current;
    if (workerRef.current) return Promise.resolve(workerRef.current);
    const worker = new SharedWorker(new URL('/src/workers/nsfw.worker.ts', import.meta.url), {
      name: 'tom_bot',
    });

    workerPromise.current = new Promise<SharedWorker>((resolve, reject) => {
      worker.port.onmessage = async function ({ data: result }: { data: MessageTypes }) {
        if (result.type === 'status') {
          if (result.status === 'warming up') {
            console.log('Tom is getting ready to look at images...');
          } else if (result.status === 'ready') {
            workerRef.current = worker;
            resolve(worker);
            workerPromise.current = undefined;
          } else reject(result.status);
          return;
        }
        const cb = callbackQueue[result.data.uuid];
        if (cb) {
          cb({ data: result });
          delete callbackQueue[result.data.uuid];
        }
      };
    });

    return workerPromise.current;
  };

  const scanImages = (
    images: { uuid: string; file: FileWithPath; meta: AsyncReturnType<typeof getMetadata> }[],
    cb: ({ data }: { data: MessageTypes }) => void
  ) => {
    if (!supportsWebWorker) {
      for (const image of images) {
        cb({
          data: {
            type: 'result',
            data: {
              nsfw: false,
              analysis: {
                drawing: 0,
                hentai: 0,
                neutral: 0,
                porn: 0,
                sexy: 0,
              },
              uuid: image.uuid,
              file: image.file,
              meta: image.meta,
            },
          },
        });
      }
      return;
    }

    getWorker().then((worker) => {
      for (const image of images) callbackQueue[image.uuid] = cb;
      worker.port.postMessage(images);
    });
  };

  return <NsfwWorkerCtx.Provider value={{ scanImages }}>{children}</NsfwWorkerCtx.Provider>;
};
