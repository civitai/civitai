import { useEffect, useRef, useState } from 'react';

// Example usage: https://github.com/infinitered/nsfwjs/blob/master/example/nsfw_demo/src/App.js

const availableModels = {
  mobilenetv2: ['/quant_nsfw_mobilenet/'],
  mobilenetMid: ['/quant_mid/', { type: 'graph' }],
  inceptionv3: ['/model/', { size: 299 }],
};

const NSFW = ['Hentai', 'Porn', 'Sexy'];

export const useClassifyModel = (args?: { model?: keyof typeof availableModels }) => {
  const workerRef = useRef<Worker>();
  const [ready, setReady] = useState(false);
  // const ref = useRef(false);
  // const { model: initialModel = 'mobilenetv2' } = args ?? {};
  // const [model, setModel] = useState<nsfwjs.NSFWJS>();
  useEffect(() => {
    workerRef.current = new Worker(new URL('/src/workers/nsfw.worker.ts', import.meta.url));
    workerRef.current.addEventListener('message', ({ data }) => {
      if (data === 'warmed up') setReady(true);
    });
    // if (!ref.current) {
    //   console.log('firfirea');
    //   ref.current = true;
    //   console.time('loading-model');
    //   nsfwjs.load(...(availableModels[initialModel] as any[])).then((m) => {
    //     console.timeEnd('loading-model');
    //     setModel(m);
    //   });
    // }
    return () => {
      if (workerRef.current) workerRef.current.terminate();
    };
  }, []); //eslint-disable-line

  // const detectNsfwGif = (predictions: nsfwjs.predictionType[][]) =>
  //   predictions.filter((c) => NSFW.includes(c[0].className)).length > 0;

  // const detectNsfwImage = (predictions: nsfwjs.predictionType[]) => {
  //   const ranked = predictions.sort((a, b) => b.probability - a.probability);
  //   return NSFW.includes(ranked[0].className);
  // };

  const isNsfw = async (image: HTMLImageElement, type: string) => {
    workerRef.current?.postMessage(image);
    // if (!model) throw new Error('model not loaded');
    // if (type === 'image/gif') {
    //   const predictions = await model.classifyGif(image, { topk: 1 });
    //   return detectNsfwGif(predictions);
    // } else {
    //   const predictions = await model.classify(image);
    //   return detectNsfwImage(predictions);
    // }
  };

  return { isNsfw: ready ? isNsfw : undefined };
};
