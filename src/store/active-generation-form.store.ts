import { create } from 'zustand';
import type { GenerationStore } from '~/components/form-graph/generation/store';

/**
 * The mounted generator form, for siblings outside its FormProvider (the queue tab) that need to
 * read the selected workflow or write a field back into the form.
 */
export const useActiveGenerationForm = create<{ store?: GenerationStore; workflow?: string }>(
  () => ({})
);
