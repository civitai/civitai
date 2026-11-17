/**
 * The ecosystems picked in the generation form or generated with, most recent first: the base model
 * picker's Recent tab.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/** Where the list lived before this store; read once so nobody's recents reset. */
const LEGACY_KEY = 'generation-recent-ecosystems';

function readLegacy(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '[]');
    return Array.isArray(value)
      ? value.filter((key): key is string => typeof key === 'string')
      : [];
  } catch {
    return [];
  }
}

export const useRecentEcosystemsStore = create<{ recent: string[] }>()(
  persist(() => ({ recent: typeof window === 'undefined' ? [] : readLegacy() }), {
    name: 'recent-ecosystems',
    storage: createJSONStorage(() => localStorage),
    version: 1,
  })
);

/** Moves an ecosystem to the front of the list. */
export function trackRecentEcosystem(ecosystem: string) {
  useRecentEcosystemsStore.setState((state) => ({
    recent: [ecosystem, ...state.recent.filter((key) => key !== ecosystem)],
  }));
}
