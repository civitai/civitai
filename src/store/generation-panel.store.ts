import { create } from 'zustand';

export type GenerationPanelView = 'generate' | 'queue' | 'feed';
export type GenerationResultsView = Exclude<GenerationPanelView, 'generate'>;

type State = {
  opened: boolean;
  view: GenerationPanelView;
  /** View to restore after an enhancement workflow completes */
  previousView?: GenerationPanelView;
};

export const useGenerationPanelStore = create<State>((set) => ({
  opened: false,
  view: 'generate',
  previousView: undefined,
}));
