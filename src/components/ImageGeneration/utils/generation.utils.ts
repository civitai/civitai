import { GenerateFormModel } from '~/server/schema/generation.schema';
import { generation } from '~/server/common/constants';

export const calculateGenerationBill = (data: Partial<GenerateFormModel>) => {
  const { quantity = 0, steps = 0, clipSkip = 0 } = data;

  return (
    generation.settingsCost.base +
    quantity * generation.settingsCost.quantity +
    steps * generation.settingsCost.steps +
    clipSkip * generation.settingsCost.clipSkip
  );
};
