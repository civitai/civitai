/**
 * Ecosystem Group Preferences Store
 *
 * Stores the last used ecosystem for each ecosystem group.
 * When a user selects an ecosystem group, this store remembers which specific
 * ecosystem variant they last used within that group.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface EcosystemGroupPreferencesState {
  /** Map of group ID -> last used ecosystem key */
  lastUsedEcosystems: Record<string, string>;
}

interface EcosystemGroupPreferencesStore extends EcosystemGroupPreferencesState {
  /** Set the last used ecosystem for a group */
  setLastUsedEcosystem: (groupId: string, ecosystemKey: string) => void;
  /** Get the last used ecosystem for a group */
  getLastUsedEcosystem: (groupId: string) => string | undefined;
}

export const useEcosystemGroupPreferencesStore = create<EcosystemGroupPreferencesStore>()(
  persist(
    (set, get) => ({
      lastUsedEcosystems: {},

      setLastUsedEcosystem: (groupId, ecosystemKey) =>
        set((state) => ({
          lastUsedEcosystems: {
            ...state.lastUsedEcosystems,
            [groupId]: ecosystemKey,
          },
        })),

      getLastUsedEcosystem: (groupId) => {
        return get().lastUsedEcosystems[groupId];
      },
    }),
    {
      name: 'ecosystem-group-preferences',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

/** Standalone accessor for use outside React components */
export const ecosystemGroupPreferencesStore = {
  setLastUsedEcosystem: (groupId: string, ecosystemKey: string) => {
    useEcosystemGroupPreferencesStore.setState((state) => ({
      lastUsedEcosystems: {
        ...state.lastUsedEcosystems,
        [groupId]: ecosystemKey,
      },
    }));
  },
  getLastUsedEcosystem: (groupId: string) => {
    return useEcosystemGroupPreferencesStore.getState().lastUsedEcosystems[groupId];
  },
  getState: () => useEcosystemGroupPreferencesStore.getState(),
};
