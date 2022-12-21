import { hideNotification, showNotification, updateNotification } from '@mantine/notifications';
import { createContext, useContext, useEffect, useState } from 'react';
import { showErrorNotification } from '~/utils/notifications';

const autoSDUrl = 'http://localhost:7860';
function civitaiFetch(endpoint: string, params: Parameters<typeof fetch>[1] = {}) {
  if (!endpoint.startsWith('/')) endpoint = '/' + endpoint;
  return fetch(`${autoSDUrl}/civitai/v1${endpoint}`, params).then((x) => x.json());
}
async function checkConnection() {
  try {
    const { status } = await civitaiFetch('/');
    if (status === 'success') return true;
    else return false;
  } catch (err: any) {  // eslint-disable-line
    return false;
  }
}
async function getModels() {
  try {
    return await civitaiFetch('/models');
  } catch (err: any) {  // eslint-disable-line
    return [];
  }
}
async function getHypernetworks() {
  try {
    return await civitaiFetch('/hypernetworks');
  } catch (err: any) {  // eslint-disable-line
    return [];
  }
}

type RunOptions = {
  generationParams?: string;
};

const RUN_NOTIFICATION_ID = 'auto-sd-model-run' as const;
async function run(modelVersionId: number, { generationParams }: RunOptions = {}) {
  showNotification({
    id: RUN_NOTIFICATION_ID,
    loading: true,
    disallowClose: true,
    autoClose: false,
    message: 'Preparing model in SD Web UI...',
  });
  try {
    await civitaiFetch(`/run/${modelVersionId}`, { method: 'post' });

    const hasSDInstance = parent?.getOpenedTabs().length > 0;
    if (hasSDInstance) {
      parent.broadCastAll({ command: 'refresh-models' });
      if (generationParams) parent.broadCastAll({ command: 'generate', generationParams });

      updateNotification({
        id: RUN_NOTIFICATION_ID,
        color: 'green',
        title: generationParams ? 'Requested image generation' : 'Model loaded',
        message: 'Your request has been communicated to the SD tab',
        disallowClose: false,
        autoClose: 3000,
      });
    } else {
      const runParams: Record<string, string> = {
        civitai_hook_child: 'true',
        civitai_refresh_models: 'true',
      };
      if (generationParams) {
        runParams.civitai_prompt = btoa(generationParams);
        runParams.civitai_generate = 'true';
      }

      const url = autoSDUrl + '?' + new URLSearchParams(runParams);
      if (!parent) await setupTabCommunication();
      parent.openNewTab({ url, windowName: 'Civitai SD' });
      hideNotification(RUN_NOTIFICATION_ID);
    }
  } catch (err: any) {  // eslint-disable-line
    updateNotification({
      id: RUN_NOTIFICATION_ID,
      color: 'red',
      title: 'Unable to load model',
      message: 'Please check that AUTOMATIC SD is running and refresh the page',
      disallowClose: false,
      autoClose: 10000,
    });
  }
}

let parent: any = null; // eslint-disable-line
async function setupTabCommunication() {
  const { Parent } = (await import('across-tabs')).default;
  parent = new Parent({
    origin: autoSDUrl,
    removeClosedTabs: true,
  });
}

type SDModel = {
  name: string;
  hash: string;
};

type AutomaticSDContext = {
  connected: boolean;
  models: SDModel[];
  hypernetworks: SDModel[];
  run: typeof run;
};

const AutomaticSDCtx = createContext<AutomaticSDContext>({} as any);  // eslint-disable-line

export function AutomaticSDContextProvider({ children }: { children: React.ReactElement }) {
  const [connected, setConnected] = useState<AutomaticSDContext['connected']>(false);
  const [models, setModels] = useState<AutomaticSDContext['models']>([]);
  const [hypernetworks, setHypernetworks] = useState<AutomaticSDContext['hypernetworks']>([]);

  useEffect(() => {
    checkConnection().then(setConnected);
  }, []);

  useEffect(() => {
    if (!connected) return;
    getHypernetworks().then(setHypernetworks);
    getModels().then(setModels);
  }, [connected]);

  return (
    <AutomaticSDCtx.Provider value={{ connected, models, hypernetworks, run }}>
      {children}
    </AutomaticSDCtx.Provider>
  );
}

export function useAutomaticSDContext() {
  const context = useContext(AutomaticSDCtx);
  if (!context)
    throw new Error('useAutomaticSDContext can only be used inside AutomaticSDContextProvider');

  return context;
}
