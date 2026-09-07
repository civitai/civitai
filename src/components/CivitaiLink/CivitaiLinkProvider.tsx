/* eslint-disable @typescript-eslint/no-empty-function */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CivitaiLinkInstance } from '~/components/CivitaiLink/civitai-link-api';
import { getCivitaiLinkBaseUrl } from '~/components/CivitaiLink/civitai-link-api';
import type {
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
import { create } from 'zustand';
import { isEqual } from 'lodash-es';
import type {
  WorkerOutgoingMessage,
  WorkerIncomingMessage,
  Instance,
  PairingStatus,
} from '~/workers/civitai-link-worker-types';
import type { MantineColor } from '@mantine/core';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

type CivitaiLinkStatus = (typeof statuses)[number];
const statuses = [
  'not-connected',
  'no-instances',
  'no-selected-instance',
  'no-socket-connection',
  'link-pending',
  'link-ready',
] as const;

export const civitaiLinkStatusColors: Record<CivitaiLinkStatus, MantineColor | undefined> = {
  'not-connected': undefined,
  'no-instances': undefined,
  'no-selected-instance': 'yellow',
  'no-socket-connection': 'red',
  'link-pending': 'yellow',
  'link-ready': 'green',
};

// #region context
type CivitaiLinkState = {
  instances?: CivitaiLinkInstance[];
  instance?: Instance;
  socketConnected: boolean;
  connected: boolean;
  resources: ResponseResourcesList['resources'];
  error?: string;
  status: CivitaiLinkStatus;
  pairingStatus?: PairingStatus;
  createInstance: (id?: number) => Promise<void>;
  deleteInstance: (id: number) => Promise<void>;
  renameInstance: (id: number, name: string) => Promise<void>;
  selectInstance: (id: number) => Promise<void>;
  deselectInstance: () => Promise<void>;
  awaitPairing: () => Promise<void>;
  cancelAwaitPairing: () => Promise<void>;
  runCommand: (command: CommandRequest) => Promise<{
    promise: Promise<unknown>;
    id: string;
    cancel: () => void;
  }>;
};

const CivitaiLinkCtx = createContext<CivitaiLinkState>({} as any);

// Shown when the current origin can't reach a Link host that would accept its
// session cookie (see `getCivitaiLinkBaseUrl`). Distinct from the
// 'Civitai Link is not enabled' flag message: the feature IS enabled for this
// user, it just cannot work from this domain.
export const UNAVAILABLE_ON_DOMAIN = 'Civitai Link is not available on this domain';
// #endregion

// #region zu store
const finalStatus: ResponseStatus[] = ['canceled', 'success', 'error'];
const completeStatus: ResponseStatus[] = ['success', 'error'];
type CivitaiLinkStore = {
  ids: string[];
  activities: Record<string, Response>;
  activityProgress: number | null;
  setActivities: (activities: Response[]) => void;
};
export const useCivitaiLinkStore = create<CivitaiLinkStore>()(
  immer((set) => ({
    ids: [] as string[],
    activities: {},
    activityProgress: null,
    setActivities: (activities: Response[]) =>
      set((state) => {
        const ids = activities.map((x) => x.id);
        if (!isEqual(state.ids, ids)) state.ids = ids;

        const dict = ids.reduce<Record<string, Response>>((acc, id) => {
          const activity = activities.find((x) => x.id === id);
          return !activity ? acc : { ...acc, [id]: activity };
        }, {});

        let minProgress: number | undefined;
        for (const id in dict) {
          const prevActivity = state.activities[id];
          const activity = dict[id];
          const inProgress =
            !finalStatus.includes(activity.status) || activity.status !== prevActivity?.status;
          if (inProgress) {
            state.activities[id] = activity;
            if (
              activity.status === 'processing' &&
              activity.progress &&
              (minProgress === undefined || activity.progress < minProgress)
            )
              minProgress = activity.progress;
          }

          const hasCompleted =
            prevActivity &&
            !finalStatus.includes(prevActivity.status) &&
            completeStatus.includes(activity.status);
          if (hasCompleted) {
            const inError = activity.status === 'error';
            if (activity.type === 'resources:add') {
              showNotification({
                title: 'Civitai Link',
                message: `${inError ? 'Failed ' : ''}Added ${
                  activity.resource.modelName
                } to your app`,
                color: inError ? 'red' : 'green',
              });
            }
          }
        }

        state.activityProgress = minProgress ?? null;
      }),
  }))
);
// #endregion

const commandPromises: Record<
  string,
  { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
> = {};

export const useCivitaiLink = () => useContext(CivitaiLinkCtx);
const Provider = ({ children }: { children: React.ReactNode }) => {
  const workerRef = useRef<SharedWorker>();
  const workerPromise = useRef<Promise<SharedWorker>>();
  const [socketConnected, setSocketConnected] = useState(false);
  const [instances, setInstances] = useState<CivitaiLinkInstance[]>();
  const [instance, setInstance] = useState<Instance>();
  const [resources, setResources] = useState<ResponseResourcesList['resources']>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string>();
  const [pairingStatus, setPairingStatus] = useState<PairingStatus>();
  const setActivities = useCivitaiLinkStore((state) => state.setActivities);

  //TODO.civitai-link - timeout when setting active instance

  const getWorker = (): Promise<SharedWorker | undefined> => {
    if (workerPromise.current) return workerPromise.current;
    if (workerRef.current) return Promise.resolve(workerRef.current);
    // The Link service authenticates ONLY via the civitai session cookie, which
    // never reaches it from an origin on a different registrable domain (PR
    // previews on *.civitaic.com, civitai.green). Spawning the worker there buys
    // nothing but a confusing `request failed (401 )` and a socket pointed at a
    // host that will never accept us — so don't. Checked here rather than in
    // render so SSR and hydration can't disagree.
    if (!getCivitaiLinkBaseUrl()) return Promise.resolve(undefined);
    // Built by `pnpm build:workers` (scripts/build-workers.mjs) → public/workers.
    // Static path (not new URL(import.meta.url)) to bypass Turbopack's broken
    // .ts SharedWorker compilation — see vercel/next.js#74842.
    const worker = new SharedWorker('/workers/civitai-link.worker.js', {
      name: 'civitai-link',
    });

    const handleError = (msg: string) => {
      console.error(msg);
      setError(msg);
    };

    const handleMessage = (msg: string) => {
      showNotification({ id: msg, message: msg, title: 'Civitai Link', color: 'blue' });
    };

    const handleInstance = (payload: Instance) => {
      setInstance(payload);
      setConnected(payload?.connected ?? false);
    };

    const handleActivities = (activities: ActivitiesResponse[]) => {
      const sorted = activities.sort((a, b) => {
        if (b.status === 'processing' && a.status !== 'processing') return 1;
        if (a.status === 'processing' && b.status !== 'processing') return -1;
        const aDate = new Date(a.createdAt ?? new Date());
        const bDate = new Date(b.createdAt ?? new Date());
        return bDate.getTime() - aDate.getTime();
      });

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

      worker.port.onmessage = async function ({ data }: { data: WorkerOutgoingMessage }) {
        if (data.type === 'ready') handleReady();
        else if (data.type === 'error') handleError(data.msg);
        else if (data.type === 'message') handleMessage(data.msg);
        else if (data.type === 'instance') handleInstance(data.payload);
        else if (data.type === 'instancesUpdate') setInstances(data.payload);
        else if (data.type === 'resourcesUpdate') setResources(data.payload);
        else if (data.type === 'activitiesUpdate') handleActivities(data.payload);
        else if (data.type === 'commandComplete') handleCommandComplete(data.payload);
        else if (data.type === 'socketConnection') setSocketConnected(data.payload);
        else if (data.type === 'pairing') setPairingStatus(data.status);
      };
    });

    return workerPromise.current;
  };

  const boot = async () => {
    const worker = await getWorker();
    if (!worker) setError(UNAVAILABLE_ON_DOMAIN);
    return worker;
  };

  const workerReq = async (req: WorkerIncomingMessage) => {
    const worker = await getWorker();
    worker?.port.postMessage(req);
  };

  const selectInstance = (id: number) => workerReq({ type: 'join', id });
  const deselectInstance = () => workerReq({ type: 'leave' });
  const createInstance = (id?: number) => workerReq({ type: 'create', id });
  const deleteInstance = (id: number) => workerReq({ type: 'delete', id });
  const renameInstance = (id: number, name: string) => workerReq({ type: 'rename', id, name });
  const awaitPairing = () => {
    const known = instances ?? [];
    setPairingStatus('waiting');
    return workerReq({
      type: 'awaitPairing',
      knownIds: known.map((x) => x.id),
      knownKeys: Object.fromEntries(known.map((x) => [x.id, x.key])),
    });
  };
  const cancelAwaitPairing = () => {
    setPairingStatus(undefined);
    return workerReq({ type: 'cancelAwaitPairing' });
  };

  const runCommand = async (command: CommandRequest, timeout = 0) => {
    const payload = command as Command;
    payload.id = uuid();

    // No reachable Link host: deliver nothing and hand back an already-settled
    // promise. Registering in `commandPromises` first would leak the entry
    // forever — nothing can complete it, and the default `timeout = 0` arms no
    // rejection timer, so `.promise` would stay pending for the page's life.
    // Settle rather than reject: callers `await runCommand(...)` (the outer
    // call) and none attach a handler to `.promise`, so a rejection here would
    // surface as an unhandled rejection.
    const worker = await getWorker();
    if (!worker) {
      setError(UNAVAILABLE_ON_DOMAIN);
      return { promise: Promise.resolve(undefined), id: payload.id, cancel: () => {} };
    }

    // Setup promise for later resolution. Note the `timeout` clock now arms
    // AFTER the worker is ready rather than before it — `getWorker()` above is
    // the wait that moved. Unobservable today (`timeout` is not on the context
    // type and no caller passes one), but it is the semantics whoever first
    // passes a timeout will get.
    const promise = new Promise((resolve, reject) => {
      commandPromises[payload.id] = { resolve, reject };
      if (timeout <= 0) return;
      setTimeout(() => {
        if (!commandPromises[payload.id]) return;
        delete commandPromises[payload.id];
        reject(new Error('Request timed out'));
      }, timeout);
    });

    // Deliberately still routed through `workerReq`, not a direct
    // `worker.port.postMessage(...)`: `postMessage` takes `any`, so posting
    // directly drops the `WorkerIncomingMessage` check on the one message that
    // carries every resource add/remove/cancel. `getWorker()` is idempotent, so
    // the second call here is just the cached promise.
    await workerReq({ type: 'command', payload });
    const cancel = () => {
      if (!commandPromises[payload.id]) return;
      runCommand({ type: 'activities:cancel', activityId: payload.id });
    };

    return { promise, id: payload.id, cancel };
  };

  const status = useMemo((): CivitaiLinkStatus => {
    if (!instances) return 'not-connected';
    if (!instances.length) return 'no-instances';
    if (!instance?.id) return 'no-selected-instance';
    if (!socketConnected) return 'no-socket-connection';
    if (!instance.connected) return 'link-pending';
    return 'link-ready';
  }, [instances, instance, socketConnected]);

  useEffect(() => {
    boot();
  }, []); // eslint-disable-line

  return (
    <CivitaiLinkCtx.Provider
      value={{
        instances,
        instance,
        connected,
        socketConnected,
        resources,
        error,
        status,
        pairingStatus,
        createInstance,
        deleteInstance,
        renameInstance,
        selectInstance,
        deselectInstance,
        awaitPairing,
        cancelAwaitPairing,
        runCommand,
      }}
    >
      {children}
    </CivitaiLinkCtx.Provider>
  );
};

export function CivitaiLinkProvider({ children }: { children: React.ReactElement }) {
  const flags = useFeatureFlags();

  return flags.civitaiLink ? (
    <Provider>{children}</Provider>
  ) : (
    <CivitaiLinkCtx.Provider
      value={{
        instances: [],
        instance: undefined,
        connected: false,
        socketConnected: false,
        resources: [],
        error: 'Civitai Link is not enabled',
        status: 'not-connected',
        pairingStatus: undefined,
        createInstance: () => Promise.resolve(),
        deleteInstance: () => Promise.resolve(),
        renameInstance: () => Promise.resolve(),
        selectInstance: () => Promise.resolve(),
        deselectInstance: () => Promise.resolve(),
        awaitPairing: () => Promise.resolve(),
        cancelAwaitPairing: () => Promise.resolve(),
        runCommand: () => Promise.resolve({ promise: Promise.resolve(), id: '', cancel: () => {} }),
      }}
    >
      {children}
    </CivitaiLinkCtx.Provider>
  );
}
