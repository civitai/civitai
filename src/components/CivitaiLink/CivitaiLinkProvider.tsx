/* eslint-disable @typescript-eslint/no-empty-function */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  CivitaiLinkInstance,
  useGetLinkInstances,
} from '~/components/CivitaiLink/civitai-link-api';
import {
  Command,
  ResponseResourcesList,
  Response,
  CommandRequest,
  ActivitiesResponse,
  ResponseStatus,
} from '~/components/CivitaiLink/shared-types';
import SharedWorker from '@okikio/sharedworker';
import { showNotification } from '@mantine/notifications';
import { v4 as uuid } from 'uuid';
import { immer } from 'zustand/middleware/immer';
import create from 'zustand';
import { useLocalStorage } from '@mantine/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import isEqual from 'lodash/isEqual';

// #region types
type Instance = {
  key: string | null;
  connected: boolean; // general connection status - aggregate of `clientsConnected` and `sdConnected`
  clientsConnected: number; // number of people in room, even though it's probably just you
  sdConnected: boolean; // if the sd instance is available to connect to
};

type SelectedInstance = CivitaiLinkInstance & Omit<Instance, 'key'>;

type IncomingMessage =
  | { type: 'ready' }
  | { type: 'socketConnection'; payload: boolean }
  | { type: 'error'; msg: string }
  | { type: 'message'; msg: string }
  | { type: 'activitiesUpdate'; payload: ActivitiesResponse[] }
  | { type: 'resourcesUpdate'; payload: ResponseResourcesList['resources'] }
  | { type: 'commandComplete'; payload: Response }
  | { type: 'instance'; payload: Instance }
  | { type: 'socketConnection'; payload: boolean };
// #endregion

// #region context
type CivitaiLinkState = {
  instances: CivitaiLinkInstance[];
  selectedInstance?: SelectedInstance;
  socketConnected: boolean;
  connected: boolean;
  resources: ResponseResourcesList['resources'];
  fetchInstances: () => Promise<void>;
  selectInstance: (instance: { key: string }) => Promise<void>;
  runCommand: (command: CommandRequest) => Promise<unknown>;
  deselectInstance: () => Promise<void>;
};

const CivitaiLinkCtx = createContext<CivitaiLinkState>({
  instances: [],
  selectedInstance: undefined,
  connected: false,
  socketConnected: false,
  resources: [],
  fetchInstances: async () => {},
  selectInstance: async () => {},
  runCommand: async () => {},
  deselectInstance: async () => {},
} as CivitaiLinkState);
// #endregion

// #region zu store
const finalStatus: ResponseStatus[] = ['canceled', 'success', 'error'];
type CivitaiLinkStore = {
  ids: string[];
  activities: Record<string, Response>;
  setActivities: (activities: Response[]) => void;
};
export const useCivitaiLinkStore = create<CivitaiLinkStore>()(
  immer((set) => ({
    ids: [],
    activities: {},
    setActivities: (activities: Response[]) =>
      set((state) => {
        const ids = activities.map((x) => x.id);
        if (!isEqual(state.ids, ids)) state.ids = ids;

        const dict = ids.reduce<Record<string, Response>>((acc, id) => {
          const activity = activities.find((x) => x.id === id);
          return !activity ? acc : { ...acc, [id]: activity };
        }, {});

        for (const id in dict) {
          const activity = dict[id];
          if (
            !finalStatus.includes(activity.status) ||
            activity.status !== state.activities[id]?.status
          )
            state.activities[id] = activity;
        }
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
  const [socketConnected, setSocketConnected] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useLocalStorage<number | undefined>({
    key: 'civitai-link-instance-id',
  });
  const { data: instances = [], refetch } = useGetLinkInstances();
  // const [instances, setInstances] = useState<CivitaiLinkInstance[]>([]);
  const [selectedInstance, setSelectedInstance] = useState<SelectedInstance>();
  const [resources, setResources] = useState<ResponseResourcesList['resources']>([]);
  const [connected, setConnected] = useState(false);
  const setActivities = useCivitaiLinkStore((state) => state.setActivities);

  console.log({ selectedInstance });

  const updateSelectedInstance = useCallback(
    (instance: Instance) => {
      const detectedInstance = instances.find((x) => x.key === instance.key);
      console.log('FIRFIREA', { instance, detectedInstance, instances });
      if (detectedInstance) {
        setSelectedInstanceId(detectedInstance?.id);
        setSelectedInstance({ ...instance, ...detectedInstance });
      }
      setConnected(instance.connected);
    },
    [instances, setSelectedInstanceId]
  );

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
      // // const detectedInstance = instances.find((x) => x.key === instance.key);
      // // console.log('FIRFIREA', { instance, detectedInstance, instances });
      // // if (detectedInstance) {
      // setSelectedInstanceId(instance.id);
      // setSelectedInstance({ ...instance });
      // // }
      // setConnected(instance.connected);
      updateSelectedInstance(instance);
    };

    const handleActivities = (activities: ActivitiesResponse[]) => {
      const sorted = activities.sort((a, b) => {
        const aDate = new Date(a.createdAt ?? new Date());
        const bDate = new Date(b.createdAt ?? new Date());
        return bDate.getTime() - aDate.getTime();
      });

      // const removed = sorted.filter((x) => x.type === 'resources:remove');
      // const added = sorted.filter((x) => x.type === 'resources:add');

      // // TODO - determine how to show that an item has been removed while still being able to show the correct status if removing an item fails
      // const filtered = added.map((activity) => {
      //   const index = removed.findIndex((x) => x.resource.hash === activity.resource.hash);
      //   return index > -1 ? removed[index] : activity;
      // });

      setActivities(sorted);
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
        else if (data.type === 'socketConnection') setSocketConnected(data.payload);
        //TODO.Justin
        // else if (data.type === 'instances.list') setSocketConnected(data.payload);
      };
    });

    return workerPromise.current;
  };

  const fetchInstances = useCallback(async () => {
    await refetch();
  }, [refetch]);

  const selectInstance = async (instance: { key: string }) => {
    const worker = await getWorker();
    worker.port.postMessage({ type: 'join', key: instance.key });
  };

  // TODO.Justin
  // const createInstance = async (instance: { key: string }) => {
  //   const worker = await getWorker();
  //   worker.port.postMessage({ type: 'join', key: instance.key });
  // };

  const runCommand = async (command: CommandRequest, timeout = 0) => {
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

  const deselectInstance = async () => {
    if (!selectedInstance) return;
    const worker = await getWorker();
    worker.port.postMessage({ type: 'leave' });
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
        socketConnected,
        resources,
        fetchInstances,
        selectInstance,
        deselectInstance,
        runCommand,
      }}
    >
      {children}
    </CivitaiLinkCtx.Provider>
  );
};

// export function ActualProvider({ children }) {
//   const { civitaiLink } = useFeatureFlags();
//   return civitaiLink ? <CivitaiLinkProvider>{children}</CivitaiLinkProvider> : children;
// }

// export function ConditionalProvider({ children, provider, condition }) {
//   return condition ? provider({ children }) : children;
// }
