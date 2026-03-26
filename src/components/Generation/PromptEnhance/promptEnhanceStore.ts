import { create } from 'zustand';

export type PromptEnhanceData = {
  prompt: string;
  negativePrompt?: string;
  ecosystem: string;
  triggerWords?: string[];
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
