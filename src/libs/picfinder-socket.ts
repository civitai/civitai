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

let socket: WebSocket | null;
let sessionId: string;
const imageRequests: Record<string, (image: ImageResult) => void> = {};

const setupSocket = () =>
  new Promise<void>((resolve, reject) => {
    socket = new WebSocket(env.NEXT_PUBLIC_PICFINDER_WS_ENDPOINT);

    // Handle sending API Key
    socket.onopen = (event) => {
      const newConnection: Record<string, any> = { apiKey: env.NEXT_PUBLIC_PICFINDER_API_KEY };
      if (sessionId) newConnection.connectionSessionUUID = sessionId;
      socket?.send(JSON.stringify({ newConnection }));
      resolve();
    };

    // Handle disconnect
    socket.onerror = (event) => {
      console.error('PicFinder API Error', event);
      socket = null;
      reject();
    };

    // Handle incoming messages
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      // Handle setting the session id
      if (data.newConnectionSessionUUID)
        sessionId = data.newConnectionSessionUUID.connectionSessionUUID;

      // Handle new images
      if (data.newImages) {
        for (const image of data.newImages.images) {
          if (imageRequests[image.taskUUID]) imageRequests[image.taskUUID](image);
        }
      }
    };
  });

const socketRequest = async (request: any) => {
  try {
    if (!socket) await setupSocket();
    socket?.send(JSON.stringify(request));
  } catch (e) {
    console.error("PicFinder API Error: Couldn't setup connection");
  }
};

const requestImage = (taskUUID: string, imageRequest: GetImageRequest) => {
  taskUUID = taskUUID ?? uuidv4();
  socketRequest({
    newTask: {
      taskUUID,
      taskType: 1,
      numberResults: 1,
      sizeId: 2,
      steps: 20,
      modelId: 1,
      gScale: 7.5,
      ...imageRequest,
    },
  });

  return taskUUID;
};

type GetImageRequest = {
  promptText: string;
  seed?: number;
  modelId?: number;
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
