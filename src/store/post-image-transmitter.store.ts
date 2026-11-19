import { faro } from '@grafana/faro-web-sdk';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { isOrchestratorUrl } from '~/server/common/constants';
import { fetchBlob, fetchBlobAsFile, MEDIA_IDLE_TIMEOUT_MS } from '~/utils/file-utils';
import { isDefined } from '~/utils/type-guards';

type DataProps = {
  url: string;
  meta?: Record<string, unknown>;
  /** The generation this output came from — lets the server verify its provenance. */
  generationWorkflowId?: string;
};

export const useOrchestratorUrlStore = create<{
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

export const ORCHESTRATOR_MEDIA_FETCH_ERROR_TYPE = 'orchestrator_media_fetch_failed';

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid-url';
  }
}

/** Error name and host only: the URL path and query can carry a signed token. */
function reportFetchFailure(url: string, reason: unknown) {
  // Duck-typed: a DOMException is not `instanceof Error` in every browser this targets.
  const name = (reason as { name?: unknown } | null)?.name;
  const errorName = typeof name === 'string' ? name : typeof reason;
  try {
    faro?.api?.pushError?.(new Error(`${ORCHESTRATOR_MEDIA_FETCH_ERROR_TYPE}: ${errorName}`), {
      type: ORCHESTRATOR_MEDIA_FETCH_ERROR_TYPE,
      context: { errorName, host: hostOf(url) },
      // Same call site every time, so Faro's dedupe would collapse a batch into one report.
      skipDedupe: true,
    });
  } catch {
    // Reporting must never break the import.
  }
}

function fileNameOf(url: string) {
  // Last path segment without query or fragment, cut to one extension.
  const name = url
    .substring(url.lastIndexOf('/') + 1)
    .split('?')[0]
    .split('#')[0];
  return name.match(/^([^.]+\.[a-zA-Z0-9]{2,5})/)?.[1] ?? name;
}

export const orchestratorMediaTransmitter = {
  setUrls: useOrchestratorUrlStore.getState().setData,
  /** One failed fetch drops only that item; `failedCount` lets the caller say so. */
  getFiles: async (key: string) => {
    const data = useOrchestratorUrlStore.getState().getData(key) ?? [];
    const results = await Promise.allSettled(
      data.map(async ({ url, meta, generationWorkflowId }) => {
        // requireOk: an expired or refused URL's error body is not an image.
        const blob = await fetchBlob(url, undefined, {
          requireOk: true,
          idleTimeoutMs: MEDIA_IDLE_TIMEOUT_MS,
        });
        if (!blob) throw Object.assign(new Error('no blob'), { name: 'NoBlob' });
        return {
          file: new File([blob], fileNameOf(url), { type: blob.type }),
          meta,
          generationWorkflowId,
        };
      })
    );
    const files: { file: File; meta?: Record<string, unknown>; generationWorkflowId?: string }[] =
      [];
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') files.push(result.value);
      else reportFetchFailure(data[i].url, result.reason);
    }
    return { files, failedCount: results.length - files.length };
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
    // Callers expect undefined on failure (drag-and-drop doesn't catch), so report and absorb it.
    const file = await fetchBlobAsFile(url, filename, {
      idleTimeoutMs: MEDIA_IDLE_TIMEOUT_MS,
    }).catch((e: unknown) => {
      reportFetchFailure(url, e);
      return null;
    });
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
