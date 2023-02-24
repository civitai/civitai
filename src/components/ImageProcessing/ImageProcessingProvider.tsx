import { createContext, useContext, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { auditMetaData, detectNsfwImage, getMetadata } from '~/utils/image-metadata';
import {
  AnalysisMessage,
  ErrorMessage,
  ImageProcessing,
  ScanImageMessage,
  StatusMessage,
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
} from '~/workers/image-processing-worker-types';
// @ts-ignore
import SharedWorker from '@okikio/sharedworker';
import { loadImage, getImageData, blurHashImage } from '~/utils/blurhash';

type MessageCallback = (data: ScanImageMessage) => void;

type NsfwWorkerState = {
  scanImages: (files: File[], cb: MessageCallback) => void;
};

const NsfwWorkerCtx = createContext<NsfwWorkerState>({} as any);
const callbackQueue: Record<string, MessageCallback> = {};
const processingQueue: Record<string, ImageProcessing> = {};

export const useImageProcessingContext = () => useContext(NsfwWorkerCtx);
export const ImageProcessingProvider = ({ children }: { children: React.ReactNode }) => {
  const workerRef = useRef<SharedWorker>();
  const workerPromise = useRef<Promise<SharedWorker>>();
  // const noSharedWorker = typeof window === 'undefined' || !('SharedWorker' in window);
  // const supportsWebWorker = !noSharedWorker;
  // const noOffscrenCanvas = typeof window === 'undefined' || !('OffscreenCanvas' in window);
  // const supportsOffscreenCanvas = !noOffscrenCanvas;

  const getWorker = () => {
    if (workerPromise.current) return workerPromise.current;
    if (workerRef.current) return Promise.resolve(workerRef.current);
    const worker = new SharedWorker(
      new URL('/src/workers/image-processing.worker.ts', import.meta.url),
      {
        name: 'image-processing',
      }
    );

    workerPromise.current = new Promise<SharedWorker>((resolve, reject) => {
      const handleReady = () => {
        workerRef.current = worker;
        resolve(worker);
      };

      worker.port.onmessage = async function ({ data }: { data: WorkerOutgoingMessage }) {
        switch (data.type) {
          case 'ready':
            return handleReady();
          case 'error':
            return handleError(data.payload);
          case 'faces':
            return handleFaces(data.payload);
          case 'nsfw':
            return handleNsfw(data.payload);
          case 'status':
            return handleStatus(data.payload);
          case 'log':
            return handleLog(data.payload);
          default:
            throw new Error('unsupported message type');
        }
      };
    });

    return workerPromise.current;
  };

  const workerReq = async (req: WorkerIncomingMessage) => {
    const worker = await getWorker();
    worker.port.postMessage(req);
  };

  const scanImages = async (files: File[], cb: MessageCallback) => {
    const displayData = files.map(
      (file): ImageProcessing => ({
        src: URL.createObjectURL(file),
        uuid: uuidv4(),
        file,
        status: 'processing',
      })
    );

    for (const item of displayData) {
      callbackQueue[item.uuid] = cb;
      processingQueue[item.uuid] = item;
      cb({ type: 'processing', payload: item });
    }

    const payload = await Promise.all(
      displayData.map(async (item) => {
        const meta = await getMetadata(item.file);
        const img = await loadImage(item.src);
        const imageData = await getImageData(img);
        const hashResult = blurHashImage(img);

        const processing = processingQueue[item.uuid];
        const payload: ImageProcessing = {
          meta,
          ...hashResult,
          ...processing,
        };
        processingQueue[item.uuid] = payload;

        cb({ type: 'processing', payload });

        return {
          uuid: item.uuid,
          file: item.file,
          meta,
          imageData,
        };
      })
    );

    workerReq({ type: 'analyze', payload });
  };

  return <NsfwWorkerCtx.Provider value={{ scanImages }}>{children}</NsfwWorkerCtx.Provider>;
};

const handleError = (data: ErrorMessage) => {
  const cb = callbackQueue[data.uuid];
  if (cb) {
    console.error(data.msg);
    cb({ type: 'error', payload: data });
    handleFinish(data.uuid);
  }
};

const handleStatus = (data: StatusMessage) => {
  const cb = callbackQueue[data.uuid];
  if (cb) {
    const payload = { ...processingQueue[data.uuid], status: data.status };
    processingQueue[data.uuid] = payload;
    cb({ type: 'processing', payload });
  }
};

const handleNsfw = (data: AnalysisMessage) => {
  const cb = callbackQueue[data.uuid];
  if (cb) {
    const processing = processingQueue[data.uuid];
    const nsfw = detectNsfwImage(data.analysis as any);
    const auditResult = auditMetaData(processing.meta, nsfw);
    const blockedFor = !auditResult?.success ? auditResult?.blockedFor : undefined;
    const payload = {
      ...processing,
      analysis: { ...processing.analysis, ...data.analysis },
      nsfw,
      blockedFor,
    };
    processingQueue[data.uuid] = payload;
    cb({ type: 'processing', payload });
  }
};

const handleFaces = (data: AnalysisMessage) => {
  const cb = callbackQueue[data.uuid];
  if (cb) {
    const processing = processingQueue[data.uuid];
    const payload = {
      ...processing,
      analysis: { ...processing.analysis, ...data.analysis },
      status: 'finished',
    } as ImageProcessing;

    processingQueue[data.uuid] = payload;
    cb({ type: 'processing', payload });
    handleFinish(data.uuid);
  }
};

const handleFinish = (uuid: string) => {
  delete callbackQueue[uuid];
  delete processingQueue[uuid];
};

const handleLog = (data: any) => {
  console.log('WORKER_LOG', data);
};
