import { createStore } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import {
  CreateGenerationRequestInput,
  GetGenerationRequestsInput,
  createGenerationRequestSchema,
  getGenerationRequestsSchema,
} from '~/server/schema/generation.schema';
import { Generation } from '~/server/services/generation/generation.types';
import { QS } from '~/utils/qs';

type RequestsDictionary = Record<number, Generation.Client.Request>;

type ImageGenerationState = {
  requests: RequestsDictionary;
  query: {
    isLoading: boolean;
    isFetching: boolean;
    isError: boolean;
    nextCursor?: number;
    call: (query: GetGenerationRequestsInput) => Promise<void>;
  };
  create: {
    isLoading: boolean;
    call: (data: CreateGenerationRequestInput) => Promise<Generation.Client.Request | undefined>;
  };
  delete: {
    isLoading: boolean;
    call: (id: number) => Promise<number>;
  };
};

const useImageGenerationStoreOld = createStore<ImageGenerationState>()(
  devtools(
    immer((set, get) => ({
      requests: {},
      query: {
        isLoading: false,
        isFetching: false,
        isError: false,
        nextCursor: undefined,
        call: async (query) => {
          const validated = getGenerationRequestsSchema.parse(query);

          set((state) => {
            if (!query.cursor) state.query.isLoading = true;
            else state.query.isFetching = true;
          });

          const response = await fetch(`/api/generation/requests?${QS.stringify(validated)}`);
          if (!response.ok) {
            set((state) => {
              state.query.isLoading = false;
              state.query.isFetching = false;
              state.query.isError = true;
            });
            return;
          }

          const {
            items,
            nextCursor,
          }: {
            items: Generation.Client.Request[];
            nextCursor?: number;
          } = await response.json();

          set((state) => {
            state.query.isLoading = false;
            state.query.isFetching = false;
            state.query.nextCursor = nextCursor;
            for (const item of items) {
              state.requests[item.id] = item;
            }
          });
        },
      },
      create: {
        isLoading: false,
        call: async (data) => {
          const validated = createGenerationRequestSchema.parse(data);

          set((state) => {
            state.create.isLoading = true;
          });

          const response = await fetch(`/api/generation/requests`, {
            method: 'POST',
            body: JSON.stringify(validated),
          });
          if (!response.ok) {
            set((state) => {
              state.create.isLoading = false;
            });
            return;
          }

          const request: Generation.Client.Request = await response.json();
          set((state) => {
            state.create.isLoading = false;
            state.requests[request.id] = request;
          });

          return request;
        },
      },
      delete: {
        isLoading: false,
        call: async (id) => {
          set((state) => {
            state.delete.isLoading = true;
          });

          const response = await fetch(`/api/generation/${id}`, { method: 'DELETE' });
          if (!response.ok) {
            set((state) => {
              state.delete.isLoading = false;
            });
          }

          set((state) => {
            state.delete.isLoading = false;
            delete state.requests[id];
          });

          return id;
        },
      },
    }))
  )
);
