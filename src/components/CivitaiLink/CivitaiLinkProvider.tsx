/* eslint-disable @typescript-eslint/no-empty-function */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CivitaiLinkInstance, getLinkInstances } from '~/components/CivitaiLink/civitai-link-api';
import { Command, ResponseResourcesList, Response } from '~/components/CivitaiLink/shared-types';
import SharedWorker from '@okikio/sharedworker';
import { showNotification } from '@mantine/notifications';
import { v4 as uuid } from 'uuid';
import { immer } from 'zustand/middleware/immer';
import create from 'zustand';
import { useLocalStorage } from '@mantine/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';

// #region types
type Instance = { key: string | null; connected: boolean };
type IncomingMessage =
  | { type: 'ready' }
  | { type: 'error'; msg: string }
  | { type: 'message'; msg: string }
  | { type: 'activitiesUpdate'; payload: Response[] }
  | { type: 'resourcesUpdate'; payload: ResponseResourcesList['resources'] }
  | { type: 'commandComplete'; payload: Response }
  | { type: 'instance'; payload: Instance };
// #endregion

// #region context
type CivitaiLinkState = {
  instances: CivitaiLinkInstance[];
  selectedInstance: CivitaiLinkInstance | undefined;
  connected: boolean;
  resources: ResponseResourcesList['resources'];
  fetchInstances: () => Promise<void>;
  selectInstance: (instance: CivitaiLinkInstance) => Promise<void>;
  runCommand: (command: Omit<Command, 'id'>) => Promise<unknown>;
};

const CivitaiLinkCtx = createContext<CivitaiLinkState>({
  instances: [],
  selectedInstance: undefined,
  connected: false,
  resources: [],
  fetchInstances: async () => {},
  selectInstance: async () => {},
  runCommand: async () => {},
} as CivitaiLinkState);
// #endregion

// #region zu store
type CivitaiLinkStore = {
  activities: Response[];
  setActivities: (activities: Response[]) => void;
};
const useCivitaiLinkStore = create<CivitaiLinkStore>()(
  immer((set) => ({
    activities: [],
    setActivities: (activities: Response[]) =>
      set((state) => {
        state.activities = activities;
      }),
  }))
);
// #endregion

const commandPromises: Record<
  string,
  { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
> = {};

export const useCivitaiLink = () => useContext(CivitaiLinkCtx);
export const CivitaiLinkProvider = ({ children }: { children: React.ReactNode }) => {
  const user = useCurrentUser();
  const canUseLink = user != null; // TODO: Briant - Check for subscription...
  const workerRef = useRef<SharedWorker>();
  const workerPromise = useRef<Promise<SharedWorker>>();
  const [selectedInstanceId, setSelectedInstanceId] = useLocalStorage<number | undefined>({
    key: 'civitai-link-instance-id',
  });
  const [instances, setInstances] = useState<CivitaiLinkInstance[]>([]);
  const [selectedInstance, setSelectedInstance] = useState<CivitaiLinkInstance | undefined>();
  const [resources, setResources] = useState<ResponseResourcesList['resources']>([]);
  const [connected, setConnected] = useState(false);
  const setActivities = useCivitaiLinkStore((state) => state.setActivities);

  const getWorker = () => {
    if (!canUseLink) throw Error('User is not logged in');
    if (workerPromise.current) return workerPromise.current;
    if (workerRef.current) return Promise.resolve(workerRef.current);
    const worker = new SharedWorker(
      new URL('/src/workers/civitai-link.worker.ts', import.meta.url),
      { name: 'civitai-link' }
    );

    const handleError = (msg: string) => {
      console.error(msg);
    };

    const handleMessage = (msg: string) => {
      showNotification({ message: msg });
    };

    const handleInstance = (instance: Instance) => {
      if (selectedInstance && instance.key && instance.key !== selectedInstance.key) {
        const detectedInstance = instances.find((x) => x.key === instance.key);
        setSelectedInstanceId(detectedInstance?.id);
        setSelectedInstance(detectedInstance);
      }
      setConnected(instance.connected);
    };

    const handleActivities = (activities: Response[]) => {
      setActivities(activities);
    };

    const handleCommandComplete = (response: Response) => {
      if (!commandPromises[response.id]) return;
      if (response.status === 'error') commandPromises[response.id].reject(response);
      else commandPromises[response.id].resolve(response);
      delete commandPromises[response.id];
    };

    workerPromise.current = new Promise<SharedWorker>((resolve) => {
      const handleReady = () => {
        workerRef.current = worker;
        resolve(worker);
      };

      worker.port.onmessage = async function ({ data }: { data: IncomingMessage }) {
        if (data.type === 'ready') handleReady();
        else if (data.type === 'error') handleError(data.msg);
        else if (data.type === 'message') handleMessage(data.msg);
        else if (data.type === 'instance') handleInstance(data.payload);
        else if (data.type === 'resourcesUpdate') setResources(data.payload);
        else if (data.type === 'activitiesUpdate') handleActivities(data.payload);
        else if (data.type === 'commandComplete') handleCommandComplete(data.payload);
      };
    });

    return workerPromise.current;
  };

  const fetchInstances = useCallback(async () => {
    setInstances(await getLinkInstances());
  }, []);

  const selectInstance = async (instance: CivitaiLinkInstance) => {
    const worker = await getWorker();
    worker.port.postMessage({ type: 'join', key: instance.key });
  };

  const runCommand = async (command: Omit<Command, 'id'>, timeout = 0) => {
    const worker = await getWorker();
    const payload = command as Command;
    payload.id = uuid();

    // Setup promise for later resolution
    const promise = new Promise((resolve, reject) => {
      commandPromises[payload.id] = { resolve, reject };
      if (timeout <= 0) return;
      setTimeout(() => {
        if (!commandPromises[payload.id]) return;
        delete commandPromises[payload.id];
        reject(new Error('Request timed out'));
      }, timeout);
    });

    worker.port.postMessage({ type: 'command', payload });

    return promise;
  };

  useEffect(() => {
    if (!canUseLink) return;
    fetchInstances();
  }, [fetchInstances, canUseLink]);

  useEffect(() => {
    if (!canUseLink || !selectedInstanceId || !instances.length || selectedInstance) return;
    const storedInstance = instances.find((x) => x.id === selectedInstanceId);
    if (storedInstance) selectInstance(storedInstance);
  }, [instances, canUseLink]);

  return (
    <CivitaiLinkCtx.Provider
      value={{
        instances,
        selectedInstance,
        connected,
        resources,
        fetchInstances,
        selectInstance,
        runCommand,
      }}
    >
      {children}
    </CivitaiLinkCtx.Provider>
  );
};
