import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { persist } from 'zustand/middleware';
import type { JudgingEngineKey } from '~/server/games/daily-challenge/challenge-judging-engine';

export type ActivityTab = 'generateContent' | 'reviewImage' | 'pickWinners';

export type JudgeDraft = {
  name?: string;
  bio?: string | null;
  systemPrompt?: string | null;
  contentPrompt?: string | null;
  reviewPrompt?: string | null;
  reviewTemplate?: string | null;
  winnerSelectionPrompt?: string | null;
  collectionPrompt?: string | null;
  userSelectable?: boolean;
  judgingEngine?: JudgingEngineKey;
};

type GenerateContentInputs = {
  modelVersionIds: number[];
};

type ReviewImageInputs = {
  imageInput: string;
  theme: string;
  themeElements: string;
  creator: string;
};

type PickWinnersInputs = {
  challengeId: string | null;
};

type PlaygroundState = {
  selectedJudgeId: number | null;
  activityTab: ActivityTab;
  aiModel: string;
  drafts: Record<number, JudgeDraft>;
  generateContentInputs: GenerateContentInputs;
  reviewImageInputs: ReviewImageInputs;
  pickWinnersInputs: PickWinnersInputs;
};

type PlaygroundActions = {
  setSelectedJudgeId: (id: number | null) => void;
  setActivityTab: (tab: ActivityTab) => void;
  setAiModel: (model: string) => void;
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
      aiModel: 'civitai/qwen3.8',
      drafts: {},
      generateContentInputs: { modelVersionIds: [] },
      reviewImageInputs: { imageInput: '', theme: '', themeElements: '', creator: '' },
      pickWinnersInputs: { challengeId: null },

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
      version: 6,
      migrate: (persistedState, version) => {
        // Migration history:
        //   v0 -> v1: x-ai/grok-4.1-fast deprecated 2026-05-15
        //   v1 -> v2: Qwen orchestrator endpoint not ready; fall back to gpt-5-nano
        //   v2 -> v3: gpt-5-nano returned empty content on generateArticle; use gpt-4o-mini
        //   v3 -> v4: Qwen 35B retired from the orchestrator
        //   v4 -> v5: gpt-4o-mini and gpt-5-nano retired from the challenge pipeline
        //   v5 -> v6: OpenRouter retired claude-sonnet-4, claude-3-5-haiku, mimo-v2.5 and
        //             step-3.5-flash (calls 404)
        // A retired model with a live successor moves to it; every other one lands on the
        // pipeline default.
        const state = persistedState as Partial<PlaygroundState> | undefined;
        const retired = [
          'x-ai/grok-4.1-fast',
          'urn:air:qwen3:repository:huggingface:Civitai/Qwen3.6-35B-A3B-Abliterated-AWQ@main.tar',
          'openai/gpt-5-nano',
          'openai/gpt-4o-mini',
        ];
        const successors: Record<string, string> = {
          'anthropic/claude-sonnet-4': 'anthropic/claude-sonnet-5.5',
          'anthropic/claude-3-5-haiku': 'anthropic/claude-haiku-5.5',
          'xiaomi/mimo-v2.5': 'xiaomi/mimo-v2.6-flash',
          'stepfun/step-3.5-flash': 'stepfun/step-3.7-flash',
        };
        if ((version ?? 0) < 6 && state?.aiModel) {
          if (successors[state.aiModel]) state.aiModel = successors[state.aiModel];
          else if (retired.includes(state.aiModel)) state.aiModel = 'civitai/qwen3.8';
        }
        return state;
      },
      partialize: (state) => ({
        selectedJudgeId: state.selectedJudgeId,
        activityTab: state.activityTab,
        aiModel: state.aiModel,
        drafts: state.drafts,
        generateContentInputs: state.generateContentInputs,
        reviewImageInputs: state.reviewImageInputs,
        pickWinnersInputs: state.pickWinnersInputs,
      }),
    }
  )
);
