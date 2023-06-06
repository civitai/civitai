import { v4 as uuidv4 } from 'uuid';
import { env } from '~/env/client.mjs';

const REQUEST_LIMIT = 5;

type ImageResult = {
  imageSrc: string;
  imageUUID: string;
  bNSFWContent: boolean;
  imageAltText: string;
  taskUUID: string;
};

let sessionId: string;
const imageRequests: Record<string, (image: ImageResult) => void> = {};

let socketPromise: Promise<WebSocket>;
let socket: WebSocket;
const getSocket = () => {
  if (socketPromise) return socketPromise;
  if (socket) return Promise.resolve(socket);

  socketPromise = new Promise((resolve, reject) => {
    const newSocket = new WebSocket(env.NEXT_PUBLIC_PICFINDER_WS_ENDPOINT);

    // Handle sending API Key
    newSocket.onopen = () => {
      const newConnection: Record<string, any> = { apiKey: env.NEXT_PUBLIC_PICFINDER_API_KEY };
      if (sessionId) newConnection.connectionSessionUUID = sessionId;
      socket = newSocket;
      socket.send(JSON.stringify({ newConnection }));
    };

    // Handle disconnect
    // newSocket.onerror = (event) => {
    //   console.log('onerror');
    //   console.error('PicFinder API Error', event);
    //   reject();
    // };

    // Handle incoming messages
    newSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      // Handle setting the session id
      if (data.newConnectionSessionUUID) {
        sessionId = data.newConnectionSessionUUID.connectionSessionUUID;
        resolve(socket);
      }

      // Handle new images
      if (data.newImages) {
        for (const image of data.newImages.images) {
          if (imageRequests[image.taskUUID]) imageRequests[image.taskUUID](image);
        }
      }
    };
  });

  return socketPromise;
};

const socketRequest = async (request: any) => {
  console.log('req', request);
  try {
    const socket = await getSocket();
    console.log('socket', socket);
    socket.send(JSON.stringify(request));
  } catch (e) {
    console.error("PicFinder API Error: Couldn't setup connection", e);
  }
};

const requestOffset: Record<string, number> = {};
const requestImage = (taskUUID: string, imageRequest: GetImageRequest) => {
  taskUUID = taskUUID ?? uuidv4();

  const requestKey = `${imageRequest.promptText}-${imageRequest.modelId}`;
  if (typeof requestOffset[requestKey] === 'undefined') requestOffset[requestKey] = 0;
  else requestOffset[requestKey]++;

  socketRequest({
    newTask: {
      taskUUID,
      taskType: 1,
      numberResults: 1,
      sizeId: 2,
      steps: 20,
      modelId: 3,
      gScale: 7.5,
      seed: 0,
      offset: requestOffset[requestKey],
      ...imageRequest,
    },
  });

  return taskUUID;
};

type GetImageRequest = {
  promptText: string;
  modelId?: number;
  numberResults?: number;
};

export const getImage = async (imageRequest: GetImageRequest, includeNsfw = false) =>
  new Promise<string>((resolve, reject) => {
    if (Object.keys(imageRequests).length > REQUEST_LIMIT) {
      reject('Too many requests');
      return;
    }

    const taskUUID = uuidv4();
    let attemptCount = 0;
    imageRequests[taskUUID] = (image: ImageResult) => {
      // If NSFW and they don't want NSFW, try again
      if (image.bNSFWContent && !includeNsfw) {
        attemptCount++;
        // If we've tried 5 times, give up
        if (attemptCount > 5) {
          reject('Too many attempts');
          delete imageRequests[taskUUID];
          return;
        }
        requestImage(taskUUID, imageRequest);
        return;
      }

      // Otherwise, send the image url
      resolve(image.imageSrc);

      // And delete the request handler
      delete imageRequests[taskUUID];
    };

    requestImage(taskUUID, imageRequest);
  });
