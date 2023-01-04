import * as nsfwjs from 'nsfwjs'; //https://github.com/infinitered/nsfwjs
import * as tf from '@tensorflow/tfjs';
tf.enableProdMode();

//Only use this web worker if the browser supports `OffscreenCanvas`
self.document = {
  createElement: () => {
    return new OffscreenCanvas(640, 480);
  },
};
self.window = self;
self.screen = {
  ...self.screen,
  width: 640,
  height: 480,
};
// let model: nsfwjs.NSFWJS;

// let db;
// const request = indexedDB

console.time('loading-model');
// nsfwjs.load('/quant_nsfw_mobilenet/').then((model) => {
//   console.timeEnd('loading-model');
//   console.log({ model });
//   model.model.save('indexeddb://model');
// });
const model = nsfwjs.load('indexeddb://model').then((model) => {
  console.timeEnd('loading-model');
  console.log({ model });
});

self.addEventListener('message', async ({ data }) => {
  // if (data.model && !model) {
  //   model = await nsfwjs.load('/model/', { size: 299 });
  // }
  // console.log({ model });
});
self.postMessage({ hi: 'this is worker' });
