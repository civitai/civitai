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

type GenerateContentInputs = {
  modelVersionIds: number[];
  userMessage: string;
};

type ReviewImageInputs = {
  imageInput: string;
  theme: string;
  creator: string;
  userMessage: string;
};

type PickWinnersInputs = {
  challengeId: string | null;
  userMessage: string;
};

type PlaygroundState = {
  selectedJudgeId: number | null;
  activityTab: ActivityTab;
  aiModel: string;
  customModelId: string;
  drafts: Record<number, JudgeDraft>;
  generateContentInputs: GenerateContentInputs;
  reviewImageInputs: ReviewImageInputs;
  pickWinnersInputs: PickWinnersInputs;
};

type PlaygroundActions = {
  setSelectedJudgeId: (id: number | null) => void;
  setActivityTab: (tab: ActivityTab) => void;
  setAiModel: (model: string) => void;
  setCustomModelId: (id: string) => void;
  updateDraft: (judgeId: number, updates: Partial<JudgeDraft>) => void;
  clearDraft: (judgeId: number) => void;
  updateGenerateContentInputs: (updates: Partial<GenerateContentInputs>) => void;
  updateReviewImageInputs: (updates: Partial<ReviewImageInputs>) => void;
  updatePickWinnersInputs: (updates: Partial<PickWinnersInputs>) => void;
};

export const usePlaygroundStore = create<PlaygroundState & PlaygroundActions>()(
  persist(
    immer((set) => ({
      selectedJudgeId: null,
      activityTab: 'generateContent' as ActivityTab,
      aiModel: 'x-ai/grok-4.1-fast',
      customModelId: '',
      drafts: {},
      generateContentInputs: { modelVersionIds: [], userMessage: '' },
      reviewImageInputs: { imageInput: '', theme: '', creator: '', userMessage: '' },
      pickWinnersInputs: { challengeId: null, userMessage: '' },

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

      updateGenerateContentInputs: (updates) =>
        set((state) => {
          Object.assign(state.generateContentInputs, updates);
        }),

      updateReviewImageInputs: (updates) =>
        set((state) => {
          Object.assign(state.reviewImageInputs, updates);
        }),

      updatePickWinnersInputs: (updates) =>
        set((state) => {
          Object.assign(state.pickWinnersInputs, updates);
        }),
    })),
    {
      name: 'judge-playground',
      partialize: (state) => ({
        selectedJudgeId: state.selectedJudgeId,
        activityTab: state.activityTab,
        aiModel: state.aiModel,
        customModelId: state.customModelId,
        drafts: state.drafts,
        generateContentInputs: state.generateContentInputs,
        reviewImageInputs: state.reviewImageInputs,
        pickWinnersInputs: state.pickWinnersInputs,
      }),
    }
  )
);
