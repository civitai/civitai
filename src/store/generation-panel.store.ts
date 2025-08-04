import { create } from 'zustand';

type State = {
  opened: boolean;
  view: 'generate' | 'queue' | 'feed';
};

export const useGenerationPanelStore = create<State>((set) => ({
  opened: false,
  view: 'generate',
}));
