import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { ExternalMetaSchema } from '~/server/schema/image.schema';
import { getOrchestratorMediaFilesFromUrls } from '~/utils/orchestration';

const useOrchestratorUrlStore = create<{
  data: Record<string, string[]>;
  setData: (key: string, urls: string[]) => void;
  getData: (key: string) => string[];
}>()(
  immer((set, get) => ({
    data: {},
    setData: (key, urls) =>
      set((state) => {
        state.data[key] = urls;
      }),
    getData: (key) => {
      const urls = get().data[key];
      set((state) => {
        delete state.data[key];
      });
      return urls;
    },
  }))
);

export const orchestratorMediaTransmitter = {
  setUrls: useOrchestratorUrlStore.getState().setData,
  getFiles: async (key: string) => {
    const urls = useOrchestratorUrlStore.getState().getData(key) ?? [];
    return await getOrchestratorMediaFilesFromUrls(urls);
  },
};

// type StringRecord = { [p: string]: unknown };

export const useExternalMetaStore = create<{
  data: ExternalMetaSchema;
  setData: (properties: ExternalMetaSchema) => void;
  getData: () => ExternalMetaSchema;
}>((set, get) => ({
  data: {},
  setData: (properties) => set({ data: properties }),
  getData: () => {
    const properties = get().data;
    set({ data: {} });
    return properties;
  },
}));
