import { useMemo, useContext, createContext, useState, useEffect } from 'react';
import { createStore, useStore } from 'zustand';
import { persist } from 'zustand/middleware';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';
import { videoGenerationConfig2 } from '~/server/orchestrator/generation/generation.config';
import { useGenerationFormStore } from '~/store/generation-form.store';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

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
  const [store] = useState(() =>
    createDataStore({
      engine: data[0]?.engine ?? (Object.keys(videoGenerationConfig2)[0] as OrchestratorEngine2),
    })
  );

  useEffect(() => {
    if (!!data.length) {
      const engine = store.getState().engine;
      if (!data.find((x) => x.engine === engine)) store.setState({ engine: data[0].engine });
    }
  }, [data, store]);

  return <Context.Provider value={store}>{children}</Context.Provider>;
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

export function useSelectedVideoGenerationEngine() {
  const { data } = useGenerationEngines();
  const selectedEngine = useGenerationFormStore((state) => state.engine);
  const isSupported = !!data.find((x) => x.engine === selectedEngine);
  return isSupported ? (selectedEngine as OrchestratorEngine2) : data[0]?.engine;
}
