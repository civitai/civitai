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
  useSignalRegistry.setState({ groups: new Set(groups).add(name) });
}
