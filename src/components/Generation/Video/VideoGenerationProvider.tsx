import { useMemo, useRef, useContext, createContext } from 'react';
import { createStore, useStore } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  OrchestratorEngine2,
  videoGenerationConfig2,
} from '~/server/orchestrator/generation/generation.config';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import { Loader } from '@mantine/core';

type StateData = {
  engine: OrchestratorEngine2;
  cost?: number;
};

type StateFns = {
  setState: (args: Partial<StateData> | ((data: StateData) => Partial<StateData>)) => void;
  getState: () => StateData;
};

type State = StateData & StateFns;

type Store = ReturnType<typeof createDataStore>;
function createDataStore(data: StateData) {
  return createStore<State>()(
    persist(
      (set, get) => ({
        ...data,
        setState: (args) => set((state) => (typeof args === 'function' ? args(state) : args)),
        getState: () => get() as StateData,
      }),
      { name: 'video-gen', version: 1, partialize: ({ engine }) => ({ engine }) }
    )
  );
}

const Context = createContext<Store | null>(null);
export function useVideoGenerationStore<T>(selector: (state: State) => T) {
  const store = useContext(Context);
  if (!store) throw new Error('missing VideoGenerationProvider');
  return useStore(store, selector);
}

export function VideoGenerationProvider({ children }: { children: React.ReactNode }) {
  const { data } = useGenerationEngines();
  const storeRef = useRef<Store | null>(null);
  if (!!data?.length && !storeRef.current) createDataStore({ engine: data[0].engine });

  return (
    <Context.Provider value={storeRef.current}>
      {/* {isLoading ? (
        <div className="flex items-center justify-center">
          <Loader />
        </div>
      ) : !data.length ? (
        <div className="flex items-center justify-center">Video generation not available</div>
      ) : (
        children
      )} */}
      {children}
    </Context.Provider>
  );
}

export function useGenerationEngines() {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.generation.getGenerationEngines.useQuery();
  const availableEngines = useMemo(
    () =>
      (data ?? [])?.filter((x) => {
        if (x.status === 'disabled') return false;
        if (x.status === 'mod-only' && !currentUser?.isModerator) return false;
        return true;
      }),
    [data, currentUser]
  );

  return useMemo(
    () => ({
      data: Object.entries(videoGenerationConfig2)
        .map(([engine, config]) => {
          const availableEngine = availableEngines.find((x) => x.engine === engine);
          if (!availableEngine) return null;
          return { ...availableEngine, ...config, engine: engine as OrchestratorEngine2 };
        })
        .filter(isDefined),
      isLoading,
    }),
    [availableEngines, isLoading]
  );
}
