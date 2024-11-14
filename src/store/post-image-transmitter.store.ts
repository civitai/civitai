import pLimit from 'p-limit';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { fetchBlob } from '~/utils/file-utils';
import { isDefined } from '~/utils/type-guards';

type DataProps = {
  url: string;
  meta?: Record<string, unknown>;
};

const useOrchestratorUrlStore = create<{
  data: Record<string, DataProps[]>;
  setData: (key: string, data: DataProps[]) => void;
  getData: (key: string) => DataProps[];
}>()(
  immer((set, get) => ({
    data: {},
    setData: (key, data) =>
      set((state) => {
        state.data[key] = data;
      }),
    getData: (key) => {
      const data = get().data[key];
      set((state) => {
        delete state.data[key];
      });
      return data;
    },
  }))
);

export const orchestratorMediaTransmitter = {
  setUrls: useOrchestratorUrlStore.getState().setData,
  getFiles: async (key: string) => {
    const data = useOrchestratorUrlStore.getState().getData(key) ?? [];
    const limit = pLimit(Infinity);
    return await Promise.all(
      data.map(({ url, meta }) =>
        limit(async () => {
          const blob = await fetchBlob(url);
          if (!blob) return;
          const lastIndex = url.lastIndexOf('/');
          const name = url.substring(lastIndex + 1);
          return {
            file: new File([blob], name, { type: blob.type }),
            meta,
          };
        })
      )
    ).then((data) => data.filter(isDefined));
  },
};

export const useExternalMetaStore = create<{
  url: string | undefined;
  setUrl: (url: string | undefined) => void;
  getUrl: () => string | undefined;
}>((set, get) => ({
  url: undefined,
  setUrl: (url) => set({ url }),
  getUrl: () => {
    const url = get().url;
    set({ url: undefined });
    return url;
  },
}));
