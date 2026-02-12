import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';

export type ActivityTab = 'generateContent' | 'reviewImage' | 'pickWinners';

export type JudgeDraft = {
  name?: string;
  bio?: string | null;
  systemPrompt?: string | null;
  contentPrompt?: string | null;
  reviewPrompt?: string | null;
  winnerSelectionPrompt?: string | null;
};

type PlaygroundState = {
  selectedJudgeId: number | null;
  activityTab: ActivityTab;
  aiModel: string;
  customModelId: string;
  drafts: Record<number, JudgeDraft>;
};

type PlaygroundActions = {
  setSelectedJudgeId: (id: number | null) => void;
  setActivityTab: (tab: ActivityTab) => void;
  setAiModel: (model: string) => void;
  setCustomModelId: (id: string) => void;
  updateDraft: (judgeId: number, updates: Partial<JudgeDraft>) => void;
  clearDraft: (judgeId: number) => void;
  hasDraft: (judgeId: number) => boolean;
};

export const usePlaygroundStore = create<PlaygroundState & PlaygroundActions>()(
  persist(
    immer((set, get) => ({
      selectedJudgeId: null,
      activityTab: 'generateContent' as ActivityTab,
      aiModel: 'x-ai/grok-4.1-fast',
      customModelId: '',
      drafts: {},

      setSelectedJudgeId: (id) =>
        set((state) => {
          state.selectedJudgeId = id;
        }),

      setActivityTab: (tab) =>
        set((state) => {
          state.activityTab = tab;
        }),

      setAiModel: (model) =>
        set((state) => {
          state.aiModel = model;
        }),

      setCustomModelId: (id) =>
        set((state) => {
          state.customModelId = id;
        }),

      updateDraft: (judgeId, updates) =>
        set((state) => {
          state.drafts[judgeId] = { ...state.drafts[judgeId], ...updates };
        }),

      clearDraft: (judgeId) =>
        set((state) => {
          delete state.drafts[judgeId];
        }),

      hasDraft: (judgeId) => {
        const draft = get().drafts[judgeId];
        return draft !== undefined && Object.keys(draft).length > 0;
      },
    })),
    {
      name: 'judge-playground',
      partialize: (state) => ({
        selectedJudgeId: state.selectedJudgeId,
        activityTab: state.activityTab,
        aiModel: state.aiModel,
        customModelId: state.customModelId,
        drafts: state.drafts,
      }),
    }
  )
);
