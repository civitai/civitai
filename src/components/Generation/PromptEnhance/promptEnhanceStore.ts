import { create } from 'zustand';
import type { SnippetReferenceValue } from '~/shared/data-graph/schemas/snippet-schema';

export type PromptEnhanceData = {
  prompt: string;
  negativePrompt?: string;
  ecosystem: string;
  triggerWords?: string[];
  /**
   * Snapshot of the snippets node's `targets` map at trigger time. Keyed by
   * target name (e.g. `prompt`, `negativePrompt`). Passed straight to the
   * enhancement mutation so `buildInstruction` can preserve the
   * `#category` references through the LLM rewrite.
   */
  snippetTargets?: Record<string, SnippetReferenceValue[]>;
};

type PromptEnhanceState = {
  data: PromptEnhanceData | null;
  setData: (data: PromptEnhanceData) => void;
  clear: () => void;
};

export const usePromptEnhanceStore = create<PromptEnhanceState>((set) => ({
  data: null,
  setData: (data) => set({ data }),
  clear: () => set({ data: null }),
}));
