import { create } from 'zustand';
import type { GenerationStore } from '~/components/form-graph/generation/store';

/**
 * The mounted generator form, for siblings outside its FormProvider (the queue tab) that write a
 * field back into the form.
 */
export const useActiveGenerationForm = create<{ store?: GenerationStore }>(() => ({}));
