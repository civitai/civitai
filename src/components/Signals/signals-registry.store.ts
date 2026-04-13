import { create } from 'zustand';

type SignalGroupName = 'training' | 'generation';

type SignalRegistryState = {
  groups: Set<SignalGroupName>;
};

export const useSignalRegistry = create<SignalRegistryState>(() => ({
  groups: new Set(),
}));

export function registerSignalGroup(name: SignalGroupName) {
  const { groups } = useSignalRegistry.getState();
  if (groups.has(name)) return;
  // Defer setState to avoid triggering updates during React render phase
  queueMicrotask(() => {
    const { groups: current } = useSignalRegistry.getState();
    if (!current.has(name)) {
      useSignalRegistry.setState({ groups: new Set(current).add(name) });
    }
  });
}
