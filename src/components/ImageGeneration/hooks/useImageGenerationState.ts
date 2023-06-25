import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { Generation } from '~/server/services/generation/generation.types';
import { isEqual } from 'lodash-es';

type RequestsDictionary = Record<number, Generation.Client.Request>;

type ImageGenerationState = {
  requests: RequestsDictionary;
  deleted: number[];
  setRequests: (requests: Generation.Client.Request[]) => void;
  removeRequest: (id: number) => void;
};

export const useImageGenerationStore = create<ImageGenerationState>()(
  devtools(
    immer((set, get) => ({
      requests: {},
      deleted: [],
      setRequests: (requests) => {
        const deleted = get().deleted;
        set((state) => {
          for (const request of requests) {
            if (deleted.includes(request.id)) break;
            if (!state.requests[request.id]) state.requests[request.id] = request;
            else if (!isEqual(state.requests[request.id], request))
              state.requests[request.id] = request;
          }
        });
      },
      removeRequest: (id) => {
        set((state) => {
          delete state.requests[id];
          state.deleted.push(id);
        });
      },
    }))
  )
);
