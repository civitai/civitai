import { createContext, useContext, useEffect, useState } from 'react';

function civitaiFetch(endpoint: string, params: Parameters<typeof fetch>[1] = {}) {
  if (!endpoint.startsWith('/')) endpoint = '/' + endpoint;
  return fetch(`http://localhost:7860/civitai/v1${endpoint}`, params).then((x) => x.json());
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

type SDModel = {
  name: string;
  hash: string;
};

type AutomaticSDContext = {
  connected: boolean;
  models: SDModel[];
  hypernetworks: SDModel[];
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
    <AutomaticSDCtx.Provider value={{ connected, models, hypernetworks }}>
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
