import type { BaseModel } from '~/shared/constants/base-model.constants';
import { createContextAndProvider } from '~/utils/create-context';

type StepContext = {
  baseModel?: string;
};

export const [StepProvider, useStepContext] = createContextAndProvider<StepContext>();
