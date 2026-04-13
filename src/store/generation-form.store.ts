/**
 * Generation Form Store
 *
 * Stores UI preferences for the generation form (media type, selected engine).
 * This is separate from generation-graph.store which handles the actual generation data.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { MediaType } from '~/shared/utils/prisma/enums';
import type { OrchestratorEngine2 } from '~/server/orchestrator/generation/generation.config';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

interface GenerationFormState {
  /** Selected media type (image or video) */
  type: MediaType;
  /** Selected video generation engine */
  engine?: OrchestratorEngine2;
  /** User-selected buzz type for generation (undefined = use site default) */
  buzzType?: BuzzSpendType;
}

interface GenerationFormStore extends GenerationFormState {
  setType: (type: MediaType) => void;
  setEngine: (engine: OrchestratorEngine2) => void;
  setBuzzType: (buzzType: BuzzSpendType) => void;
}

export const useGenerationFormStore = create<GenerationFormStore>()(
  persist(
    (set) => ({
      type: 'image',
      engine: undefined,
      buzzType: undefined,

      setType: (type) => set({ type }),
      setEngine: (engine) => set({ engine }),
      setBuzzType: (buzzType) => set({ buzzType }),
    }),
    {
      name: 'generation-form-ui',
      storage: createJSONStorage(() => localStorage),
      version: 1,
    }
  )
);

/** Standalone accessor for use outside React components */
export const generationFormStore = {
  setType: (type: MediaType) => {
    useGenerationFormStore.setState({ type });
  },
  setEngine: (engine: OrchestratorEngine2) => {
    useGenerationFormStore.setState({ engine });
  },
  setBuzzType: (buzzType: BuzzSpendType) => {
    useGenerationFormStore.setState({ buzzType });
  },
  getState: () => useGenerationFormStore.getState(),
};
