import { imageAnalysisSchema } from './../server/schema/image.schema';
import { FileWithPath } from '@mantine/dropzone';
import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { z } from 'zod';

setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm/wasm-out/');
tf.enableProdMode();

export type NSFW_TYPES = 'drawing' | 'hentai' | 'neutral' | 'porn' | 'sexy';
export type NSFW_ANALYSIS = z.infer<typeof imageAnalysisSchema>;
export type PredictionType = {
  className: NSFW_TYPES;
  probability: number;
};

interface SharedWorkerGlobalScope {
  onconnect: (event: MessageEvent) => void;
}
const _self: SharedWorkerGlobalScope = self as any;

// const counter = 0;
// _self.onconnect = (e) => {
//   const port = e.ports[0];
//   console.log({ ports: e.ports });
//   console.log('test', counter);
//   port.onmessage = function (e) {
//     counter++;
//     console.log('onmessage', { e });
//     port.postMessage(`response: ${counter}`);
//   };
// };

let model: tf.LayersModel;
const SIZE = 299;
const NSFW_CLASSES: Record<number, NSFW_TYPES> = {
  0: 'drawing',
  1: 'hentai',
  2: 'neutral',
  3: 'porn',
  4: 'sexy',
};

function nsfwProcess(values: Int32Array | Uint8Array | Float32Array) {
  const topK = 5;
  const valuesAndIndices = [];
  const topkValues = new Float32Array(topK);
  const topkIndices = new Int32Array(topK);
  const results = {
    drawing: 0,
    hentai: 0,
    neutral: 0,
    porn: 0,
    sexy: 0,
  };

  console.log({ topkIndices, topkValues, values });

  for (let i = 0; i < values.length; i++) {
    valuesAndIndices.push({ value: values[i], index: i });
  }

  valuesAndIndices.sort((a, b) => b.value - a.value);
  for (let i = 0; i < topK; i++) {
    topkValues[i] = valuesAndIndices[i].value;
    topkIndices[i] = valuesAndIndices[i].index;
  }

  // const topClassesAndProbs: PredictionType[] = [];
  for (let i = 0; i < topkIndices.length; i++) {
    results[NSFW_CLASSES[topkIndices[i]]] = topkValues[i];
    // topClassesAndProbs.push({
    //   className: NSFW_CLASSES[topkIndices[i]],
    //   probability: topkValues[i],
    // });
  }
  // console.log({ topClassesAndProbs });
  return results;
}

async function analyzeImage(bitmap: ImageBitmap) {
  const { width: w, height: h } = bitmap;
  const offScreen = new OffscreenCanvas(w, h);
  const ctx = offScreen.getContext('2d') as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0, w, h);

  const canvasData = ctx.getImageData(0, 0, w, h).data;
  const img = new ImageData(canvasData, w, h);
  const pixels = tf.browser.fromPixels(img);
  const normalized = pixels.toFloat().div(tf.scalar(255)) as tf.Tensor3D;

  let resized = normalized;
  if (pixels.shape[0] !== SIZE || pixels.shape[1] !== SIZE) {
    resized = tf.image.resizeBilinear(normalized, [SIZE, SIZE], true);
  }

  const batched = resized.reshape([1, SIZE, SIZE, 3]);
  const predictions = (await model.predict(batched)) as tf.Tensor;
  const values = await predictions.data();
  const result = nsfwProcess(values);
  predictions.dispose();
  return result;
}

function detectNsfwImage(analysis: NSFW_ANALYSIS) {
  const ranked = Object.entries(analysis)
    .sort((a, b) => b[1] - a[1])
    .map(([key, value]) => ({ className: key, probability: value }));
  return ['nsfw', 'hentai'].includes(ranked[0].className);
}

_self.onconnect = async (e) => {
  const port = e.ports[0];
  port.onmessage = async ({ data }) => {
    const array = data as { url: string; file: FileWithPath }[];
    try {
      const result = await Promise.all(
        array.map(async ({ url, file }) => {
          const bitmap = await createImageBitmap(file);
          const analysis = await analyzeImage(bitmap);
          const nsfw = detectNsfwImage(analysis);
          return { url, analysis, nsfw };
        })
      );
      port.postMessage(result);
    } catch (error) {
      port.postMessage({ type: 'error', error });
    }
  };

  if (!model) {
    await tf.setBackend('wasm');
    try {
      model = await tf.loadLayersModel('indexeddb://model');
      console.log('Load NSFW Model!');
    } catch (e) {
      model = await tf.loadLayersModel('/model/model.json');
      model.save('indexeddb://model');
      console.log('Save NSFW Model!');
    } finally {
      // warm up
      const result = tf.tidy(() => model.predict(tf.zeros([1, SIZE, SIZE, 3]))) as tf.Tensor;
      await result.data();
      result.dispose();
      console.log('warmed up');
      port.postMessage('ready');
    }
  } else {
    console.log('else');
    const result = tf.tidy(() => model.predict(tf.zeros([1, SIZE, SIZE, 3]))) as tf.Tensor;
    await result.data();
    result.dispose();
    console.log('warmed up');
    port.postMessage('ready');
  }
};
