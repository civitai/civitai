import type { BaseModel } from '~/server/common/constants';
import { createContextAndProvider } from '~/utils/create-context';

type StepContext = {
  baseModel?: string;
};

export const [StepProvider, useStepContext] = createContextAndProvider<StepContext>();
