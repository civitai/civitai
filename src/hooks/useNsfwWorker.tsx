import { FileWithPath } from '@mantine/dropzone';
import { useEffect, useRef, useState } from 'react';

type NSFW_TYPES = 'Drawing' | 'Hentai' | 'Neutral' | 'Porn' | 'Sexy';
export type PredictionType = {
  className: NSFW_TYPES;
  probability: number;
};

const NSFW = ['Hentai', 'Porn', 'Sexy'];

export const useNsfwWorker = () => {
  // const workerRef = useRef<Worker>();
  // const [ready, setReady] = useState(false);
  // const [results, setResults] = useState<PredictionType[]>([]);
  // useEffect(() => {
  //   workerRef.current = new Worker(new URL('/src/workers/nsfw.worker.ts', import.meta.url));
  //   workerRef.current.addEventListener('message', ({ data }) => {
  //     console.log({ message: data });
  //     if (typeof data === 'string' && data === 'ready') setReady(true);
  //     else if (typeof data === 'object') {
  //       const { index, result } = data;
  //     }
  //   });
  //   return () => {
  //     if (workerRef.current) workerRef.current.terminate();
  //   };
  // }, []); //eslint-disable-line
  // const detectNsfwImage = (predictions: PredictionType[]) => {
  //   const ranked = predictions.sort((a, b) => b.probability - a.probability);
  //   return NSFW.includes(ranked[0].className);
  // };
  // // const isNsfw = async (file: FileWithPath) => {
  // //   // if (file.type !== 'image/gif') {
  // //   //   // add an empty queue item
  // //   //   // workerRef.current?.postMessage(file);
  // //   //   return new Promise((resolve, reject) => {
  // //   //     workerRef.current.onmessage = ({ data }) => {
  // //   //       console.log({ data });
  // //   //       resolve(data);
  // //   //     };
  // //   //     // workerRef.current?.onerror?.((error) => {
  // //   //     //   reject(error);
  // //   //     // });
  // //   //     workerRef.current?.postMessage(file);
  // //   //   });
  // //   // }
  // //   //   const predictions = await model.classify(image);
  // //   //   return detectNsfwImage(predictions);
  // // };
  // const getNsfwResults = async (files: FileWithPath[]) => {
  //   const imageFiles = files.filter((x) => x.type !== 'image/gif');
  //   if (imageFiles.length) {
  //     return new Promise<Array<{ index: number; nsfw: boolean }>>((resolve, reject) => {
  //       workerRef.current.onmessage = ({ data }: { data: { index: number; nsfw: boolean }[] }) => {
  //         console.log({ resolved: data });
  //         resolve(data);
  //       };
  //       workerRef.current.onerror = (error) => reject(error);
  //       workerRef.current?.postMessage(imageFiles);
  //     });
  //   }
  // };
  // return { getNsfwResults };
};
