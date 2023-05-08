import { ImageAnalysisInput } from '../server/schema/image.schema';
import * as tf from '@tensorflow/tfjs';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import QueueOld from '~/utils/queue';
import { env as clientEnv } from '~/env/client.mjs';
import {
  WorkerIncomingMessage,
  WorkerOutgoingMessage,
  NSFW_TYPES,
  AnalyzePayload,
} from './image-processing-worker-types';
import * as H from '@vladmandic/human';

const wasmPath = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-wasm/wasm-out/';
setWasmPaths(wasmPath);
tf.enableProdMode();

// --------------------------------
// Types
// --------------------------------
interface SharedWorkerGlobalScope {
  onconnect: (event: MessageEvent) => void;
}
const _self: SharedWorkerGlobalScope = self as any;

let model: tf.LayersModel;
let initializing = false;
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
  }
  return results;
}

const inintializeNsfwModel = async () => {
  try {
    model = await tf.loadLayersModel('indexeddb://model');
    console.log('Load NSFW Model!');
  } catch (e) {
    model = await tf.loadLayersModel(clientEnv.NEXT_PUBLIC_CONTENT_DECTECTION_LOCATION);
    model.save('indexeddb://model');
    console.log('Save NSFW Model!');
  }
  // const result = tf.tidy(() => model.predict(tf.zeros([1, SIZE, SIZE, 3]))) as tf.Tensor;
  // await result.data();
  // result.dispose();
};

const analyzeImage = async (img: ImageData) => {
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
};

let human: H.Human;
const humanConfig: Partial<H.Config> = {
  modelBasePath: 'https://publicstore.civitai.com/face_detection/',
  async: true,
  wasmPath,
  backend: 'wasm',
  face: {
    enabled: true,
    detector: {
      enabled: true,
      maxDetected: 10,
      return: false,
      rotation: false,
      minConfidence: 0.2,
    },
    iris: { enabled: false },
    description: { enabled: true },
    emotion: { enabled: true },
    antispoof: { enabled: true },
    liveness: { enabled: true },
  },
  body: { enabled: false },
  hand: { enabled: false },
  object: { enabled: false },
  gesture: { enabled: false },
  segmentation: { enabled: false },
  // debug: true,
  // modelBasePath: 'https://vladmandic.github.io/human-models/models/',
  // filter: { enabled: true, equalization: false, flip: false },
  // face: {
  //   enabled: true,
  //   detector: { rotation: false, maxDetected: 100, minConfidence: 0.2, return: true },
  //   iris: { enabled: true },
  //   description: { enabled: true },
  //   emotion: { enabled: true },
  //   antispoof: { enabled: true },
  //   liveness: { enabled: true },
  // },
  // body: { enabled: false },
  // hand: { enabled: false },
  // object: { enabled: false },
  // gesture: { enabled: false },
  // segmentation: { enabled: false },
};

const start = async (port: MessagePort) => {
  if (!port.postMessage) return;

  const portReq = (req: WorkerOutgoingMessage) => port.postMessage(req);

  const detectFaces = async (img: ImageData) => {
    if (typeof OffscreenCanvas === 'undefined') return [];
    if (!human) human = new H.Human(humanConfig);
    try {
      const { face } = await human.detect(img);
      return face
        ?.filter((f) => f.age)
        .map((f) => ({
          age: f.age,
          gender: f.gender,
          genderConfidence: f.genderScore,
          emotions: f.emotion,
          real: f.real,
          live: f.live,
        }));
    } catch (e: any) {
      console.error(e);
      throw e;
    }
  };

  const handleAnalyze = async (payload: AnalyzePayload) => {
    for (let i = 0; i < payload.length; i++) {
      QueueOld.enqueue(
        () =>
          new Promise(async (resolve, reject) => {
            const { uuid, file, imageData } = payload[i];
            try {
              portReq({ type: 'status', payload: { uuid, status: 'nsfw' } });
              const analysis = await analyzeImage(imageData);
              portReq({ type: 'nsfw', payload: { uuid, analysis } });

              portReq({ type: 'status', payload: { uuid, status: 'faces' } });
              const faces = await detectFaces(imageData);
              portReq({ type: 'faces', payload: { uuid, analysis: { faces } } });
              // portReq({ type: 'status', payload: { uuid, status: 'finished' } });

              resolve({});
            } catch (error: any) {
              portReq({ type: 'error', payload: { msg: error.message, uuid } });
              reject({ error });
            }
          })
      );
    }
  };

  // #region [incoming messages]
  port.onmessage = async ({ data }: { data: WorkerIncomingMessage }) => {
    if (data.type === 'analyze') handleAnalyze(data.payload);
  };
  // #endregion

  // #region [initialize]
  if (!model) {
    if (!initializing) {
      initializing = true;
      await tf.setBackend('wasm');
      await inintializeNsfwModel();
      portReq({ type: 'ready' });
      initializing = false;
    }
  } else portReq({ type: 'ready' });
  // #endregion
};

_self.onconnect = (e) => {
  const [port] = e.ports;
  start(port);
};

// This is the fallback, just in case the browser doesn't support SharedWorkers natively
if ('SharedWorkerGlobalScope' in _self) start(_self as any); // eslint-disable-line @typescript-eslint/no-explicit-any
