import pLimit from 'p-limit';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { isOrchestratorUrl } from '~/server/common/constants';
import { fetchBlob, fetchBlobAsFile } from '~/utils/file-utils';
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

function MediaDropzoneData() {
  const dictionary: Record<string, Record<string, unknown>> = {};

  function setData(url: string, data: Record<string, unknown>) {
    dictionary[url] = data;
  }

  async function getData(url: string, options?: { allowExternalUrl?: boolean }) {
    const { allowExternalUrl } = options ?? {};
    const data = dictionary[url] ?? {};
    delete dictionary[url];
    if (!allowExternalUrl && !isOrchestratorUrl(url)) return;
    const filename = url.substring(url.lastIndexOf('/')).split('?')[0];
    const file = await fetchBlobAsFile(url, filename);
    if (!file) return;
    return { file, data };
  }

  async function getAllData(options?: { allowExternalUrl?: boolean }) {
    return await Promise.all(Object.keys(dictionary).map((url) => getData(url, options))).then(
      (data) => data.filter(isDefined)
    );
  }

  return { setData, getData, getAllData };
}

export const mediaDropzoneData = MediaDropzoneData();
