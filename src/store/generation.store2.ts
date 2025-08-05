import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { GetGenerationDataInput } from '~/server/schema/generation.schema';
import type {
  GenerationData,
  GenerationResource,
  RemixOfProps,
} from '~/server/services/generation/generation.service';
import { getSourceImageFromUrl } from '~/shared/constants/generation.constants';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { QS } from '~/utils/qs';

export type RunType = 'run' | 'remix' | 'replay';
export type GenerationPanelView = 'queue' | 'generate' | 'feed';

type State = {
  counter: number;
  loading: boolean;
  opened: boolean;
  view: GenerationPanelView;
  type: MediaType;
  engine?: string;

  setView: (value: GenerationPanelView) => void;
  setType: (value: MediaType) => void;
  setEngine: (value: string) => void;
};

export const useGenerationStore = create<State>((set) => ({
  counter: 0,
  loading: false,
  opened: false,
  view: 'generate',
  type: 'image',

  setView: (view) => set({ view }),
  setType: (type) => set({ type }),
  setEngine: (engine) => set({ engine }),
}));
