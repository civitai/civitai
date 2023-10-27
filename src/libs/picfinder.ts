import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { env } from '~/env/client.mjs';
import { hashify } from '~/utils/string-helpers';

const REQUEST_LIMIT = 5;
const CONNECTION_TIMEOUT = 60; // Seconds

type ImageResult = {
  imageSrc: string;
  imageUUID: string;
  bNSFWContent: boolean;
  imageAltText: string;
  taskUUID: string;
};

let sessionId: string;
const imageRequests: Record<string, (image: ImageResult) => void> = {};

let socketPromise: Promise<WebSocket> | undefined;
let socket: WebSocket | undefined;
const getSocket = () => {
  if (!env.NEXT_PUBLIC_PICFINDER_API_KEY || !env.NEXT_PUBLIC_PICFINDER_WS_ENDPOINT) return;

  if (socketPromise) return socketPromise;
  if (socket) {
    if (socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
    else {
      socket.close();
      socket = undefined;
    }
  }

  let closeTimeout: NodeJS.Timeout;
  socketPromise = new Promise((resolve, reject) => {
    const newSocket = new WebSocket(env.NEXT_PUBLIC_PICFINDER_WS_ENDPOINT as string);

    // Handle sending API Key
    newSocket.onopen = () => {
      const newConnection: Record<string, any> = { apiKey: env.NEXT_PUBLIC_PICFINDER_API_KEY };
      if (sessionId) newConnection.connectionSessionUUID = sessionId;
      socket = newSocket;
      socket.send(JSON.stringify({ newConnection }));
    };

    // Handle incoming messages
    newSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      // Handle setting the session id
      if (data.newConnectionSessionUUID) {
        sessionId = data.newConnectionSessionUUID.connectionSessionUUID;
        resolve(newSocket);
      }

      // Handle new images
      if (data.newImages) {
        for (const image of data.newImages.images) {
          if (imageRequests[image.taskUUID]) imageRequests[image.taskUUID](image);
        }
      }

      // Close the socket after 60 seconds
      if (closeTimeout) clearTimeout(closeTimeout);
      closeTimeout = setTimeout(() => newSocket.close(), 1000 * CONNECTION_TIMEOUT);
    };

    newSocket.onclose = () => {
      socket = undefined;
      socketPromise = undefined;
    };
  });

  return socketPromise;
};

const socketRequest = async (request: any) => {
  try {
    const socket = await getSocket();
    socket?.send(JSON.stringify(request));
  } catch (e) {
    console.error("PicFinder API Error: Couldn't setup connection", e);
  }
};

let requestOffset: Record<string, number>;
const getRandomStartingOffset = () => Math.floor(Math.random() * 100);
const getRequestOffset = (request: GetImageRequest) => {
  const requestKey = `${request.modelId}:${hashify(request.promptText)}`;
  if (!requestOffset) {
    requestOffset = JSON.parse(localStorage.getItem('picfinder-request-offset') ?? '{}');
  }

  if (typeof requestOffset[requestKey] === 'undefined')
    requestOffset[requestKey] = getRandomStartingOffset();
  else requestOffset[requestKey] += request.numberResults ?? 1;

  localStorage.setItem('picfinder-request-offset', JSON.stringify(requestOffset));
  return requestOffset[requestKey];
};

const requestImage = (taskUUID: string, imageRequest: GetImageRequest) => {
  taskUUID = taskUUID ?? uuidv4();

  const numberResults = imageRequest.numberResults ?? 1;
  socketRequest({
    newTask: {
      taskUUID,
      taskType: 1,
      numberResults,
      sizeId: 2,
      steps: 30,
      modelId: 3,
      gScale: 7.5,
      offset: getRequestOffset(imageRequest),
      ...imageRequest,
    },
  });

  return taskUUID;
};

type GetImageRequest = {
  promptText: string;
  modelId?: number;
  numberResults?: number;
  includeNsfw?: boolean;
};

function requestImages(
  { includeNsfw = true, ...imageRequest }: GetImageRequest,
  cb: (url: string | undefined, isComplete: boolean) => void
) {
  if (Object.keys(imageRequests).length > REQUEST_LIMIT) throw new Error('Too many requests');

  const taskUUID = uuidv4();
  let attemptCount = 0;
  let imagesRemaining = imageRequest.numberResults ?? 1;
  const requestTimeout = setTimeout(() => {
    if (imageRequests[taskUUID]) delete imageRequests[taskUUID];
    cb(undefined, true);
  }, 1000 * 10 * imagesRemaining);

  imageRequests[taskUUID] = (image: ImageResult) => {
    // If NSFW and they don't want NSFW, try again
    if (image.bNSFWContent && !includeNsfw) {
      attemptCount++;
      // If we've tried 5 times, give up
      if (attemptCount > 5) {
        delete imageRequests[taskUUID];
        throw new Error('Too many attempts');
      }
      requestImage(taskUUID, imageRequest);
      return;
    }

    // Delete the request handler
    imagesRemaining--;
    const isComplete = imagesRemaining <= 0;
    if (isComplete) {
      delete imageRequests[taskUUID];
      clearTimeout(requestTimeout);
    }

    // Otherwise, send the image url
    cb(image.imageSrc, isComplete);
  };

  requestImage(taskUUID, imageRequest);
}

const DEFAULT_MODEL_ID = 3;
export function usePicFinder({
  initialPrompt,
  modelId,
  initialFetchCount = 0,
}: {
  initialPrompt: string;
  initialFetchCount?: number;
  modelId?: number;
}) {
  modelId = modelId ?? DEFAULT_MODEL_ID;
  const [images, setImages] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [promptText, setPromptText] = useState(initialPrompt);

  useEffect(() => {
    const currentCount = images[promptText]?.length ?? 0;
    if (initialFetchCount > 0 && currentCount === 0 && promptText) getImages(initialFetchCount);
  }, [promptText]);

  const getImages = async (numberResults = 3) => {
    if (loading[promptText]) return;

    setLoading((x) => ({
      ...x,
      [promptText]: true,
    }));

    const onImageReady = (url: string | undefined, isComplete: boolean) => {
      if (isComplete) setLoading((x) => ({ ...x, [promptText]: false }));
      if (!url) return;

      setImages((x) => ({
        ...x,
        [promptText]: [...(x[promptText] ?? []), url],
      }));
    };
    requestImages({ promptText, modelId, numberResults }, onImageReady);
  };

  const setPrompt = (prompt: string) => {
    setPromptText(prompt);
  };

  const clear = () => {
    setImages((x) => ({
      ...x,
      [promptText]: [],
    }));
  };

  return {
    images: images[promptText] ?? [],
    loading: loading[promptText] ?? false,
    prompt: promptText,
    getImages,
    setPrompt,
    clear,
  };
}
