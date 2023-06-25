import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { Generation } from '~/server/services/generation/generation.types';
import { isEqual } from 'lodash-es';

type RequestsDictionary = Record<number, Generation.Client.Request>;

type ImageGenerationState = {
  requests: RequestsDictionary;
  feed: Generation.Image[];
  deletedRequests: number[];
  setRequests: (requests: Generation.Client.Request[]) => void;
  removeRequest: (id: number) => void;
};

export const useImageGenerationStore = create<ImageGenerationState>()(
  devtools(
    immer((set, get) => ({
      requests: {},
      feed: [],
      deletedRequests: [],
      setRequests: (requests) => {
        const deleted = get().deletedRequests;
        set((state) => {
          for (const request of requests) {
            if (deleted.includes(request.id)) break;
            if (!state.requests[request.id]) {
              // add request data
              state.requests[request.id] = request;
              // add image data
              for (const image of request.images ?? []) {
                state.feed.push(image);
              }
            } else if (!isEqual(state.requests[request.id], request))
              state.requests[request.id] = request;
          }
        });
      },
      removeRequest: (id) => {
        set((state) => {
          // remove request
          delete state.requests[id];
          // ensure request isn't added again by `setRequests`
          state.deletedRequests.push(id);
          // remove request images from feed
          state.feed = [...state.feed.filter((x) => x.requestId !== id)];
        });
      },
    }))
  )
);
