//based on https://gist.github.com/YankeeTube/ee96f60f57b9038ee0b703fc6620e7d9
import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';

setWasmPaths('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm/wasm-out/');

type NSFW_TYPES = 'Drawing' | 'Hentai' | 'Neutral' | 'Porn' | 'Sexy';
export type PredictionType = {
  className: NSFW_TYPES;
  probability: number;
};

tf.enableProdMode();

let model: tf.LayersModel;
const SIZE = 299;
const NSFW_CLASSES: Record<number, NSFW_TYPES> = {
  0: 'Drawing',
  1: 'Hentai',
  2: 'Neutral',
  3: 'Porn',
  4: 'Sexy',
};

function nsfwProcess(values: any) {
  const topK = 5;
  const valuesAndIndices = [];
  const topkValues = new Float32Array(topK);
  const topkIndices = new Int32Array(topK);

  for (let i = 0; i < values.length; i++) {
    valuesAndIndices.push({ value: values[i], index: i });
  }

  valuesAndIndices.sort((a, b) => b.value - a.value);
  for (let i = 0; i < topK; i++) {
    topkValues[i] = valuesAndIndices[i].value;
    topkIndices[i] = valuesAndIndices[i].index;
  }

  const topClassesAndProbs: PredictionType[] = [];
  for (let i = 0; i < topkIndices.length; i++) {
    topClassesAndProbs.push({
      className: NSFW_CLASSES[topkIndices[i]],
      probability: topkValues[i],
    });
  }
  return topClassesAndProbs;
}

async function detectNSFW(bitmap: ImageBitmap) {
  const { width: w, height: h } = bitmap;
  // const canvas = document.createElement('canvas');
  // const offScreen = canvas.transferControlToOffscreen()
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
  console.log(result);
  self.postMessage(result);
}

async function main() {
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
    self.postMessage('warmed up');
  }
}

main();

const handleMessage = async ({ data }) => {
  console.log({ data });
  const bitmap = await createImageBitmap(data);
  console.log({ bitmap });
  detectNSFW(bitmap);
};

addEventListener('message', handleMessage);
