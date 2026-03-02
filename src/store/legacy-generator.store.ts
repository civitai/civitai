/**
 * Legacy Generator Store
 *
 * Manages the user preference for using the legacy generation form vs the new data-graph form.
 * Default behavior:
 * - Existing users (who have 'generation-form-2' localStorage key) -> default to legacy
 * - New users (no localStorage key) -> default to new generator
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// =============================================================================
// Constants
// =============================================================================

const STORAGE_KEY = 'use-legacy-generator';
const OLD_FORM_KEY = 'generation-form-2';

// =============================================================================
// Types
// =============================================================================

interface LegacyGeneratorState {
  /** Whether to use the legacy generator (true) or new generator (false) */
  useLegacy: boolean;
  /** Whether the preference has been explicitly set by the user */
  hasExplicitPreference: boolean;
  /** Switch to the new generator */
  switchToNew: () => void;
  /** Switch to the legacy generator */
  switchToLegacy: () => void;
  /** Toggle between generators */
  toggle: () => void;
}

// =============================================================================
// Helper
// =============================================================================

/**
 * Determine the default value based on existing user data.
 * - If user has 'generation-form-2' localStorage key -> existing user -> default to legacy
 * - If no key exists -> new user -> default to new generator
 */
function getDefaultValue(): boolean {
  if (typeof window === 'undefined') return false;
  const hasOldFormData = localStorage.getItem(OLD_FORM_KEY) !== null;
  return hasOldFormData;
}

// =============================================================================
// Store
// =============================================================================

export const useLegacyGeneratorStore = create<LegacyGeneratorState>()(
  persist(
    (set, get) => ({
      useLegacy: getDefaultValue(),
      hasExplicitPreference: false,

      switchToNew: () => set({ useLegacy: false, hasExplicitPreference: true }),
      switchToLegacy: () => set({ useLegacy: true, hasExplicitPreference: true }),
      toggle: () => set((state) => ({ useLegacy: !state.useLegacy, hasExplicitPreference: true })),
    }),
    {
      name: STORAGE_KEY,
      partialize: (state) => ({
        useLegacy: state.useLegacy,
        hasExplicitPreference: state.hasExplicitPreference,
      }),
      // On rehydration, if no explicit preference was set, recalculate the default
      onRehydrateStorage: () => (state) => {
        if (state && !state.hasExplicitPreference) {
          state.useLegacy = getDefaultValue();
        }
      },
    }
  )
);

// =============================================================================
// Selectors
// =============================================================================

export const selectUseLegacy = (state: LegacyGeneratorState) => state.useLegacy;
export const selectHasExplicitPreference = (state: LegacyGeneratorState) =>
  state.hasExplicitPreference;
