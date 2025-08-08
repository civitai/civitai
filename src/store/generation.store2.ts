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
};

export const useGenerationStore = create<State>((set) => ({
  counter: 0,
  loading: false,
  opened: false,

  open: () => undefined,
  close: () => undefined,
}));
