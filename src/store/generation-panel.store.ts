import { create } from 'zustand';

type PanelView = 'generate' | 'queue' | 'feed';

type State = {
  opened: boolean;
  view: PanelView;
  /** View to restore after an enhancement workflow completes */
  previousView?: PanelView;
};

export const useGenerationPanelStore = create<State>((set) => ({
  opened: false,
  view: 'generate',
  previousView: undefined,
}));
