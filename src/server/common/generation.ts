import { GenerateFormModel } from '~/server/schema/generation.schema';
import { generation, getGenerationConfig } from '~/server/common/constants';

export const calculateGenerationBill = (data: Partial<GenerateFormModel>) => {
  const {
    quantity = generation.defaultValues.quantity,
    steps = generation.defaultValues.steps,
    aspectRatio = generation.defaultValues.aspectRatio,
    baseModel = 'SD1',
  } = data;

  const { aspectRatios, costs } = getGenerationConfig(baseModel);
  const aspectRatioPosition = Number(aspectRatio);
  const { width, height } = aspectRatios[aspectRatioPosition];

  return Math.ceil(
    costs.base * (width / costs.width) * (height / costs.height) * (steps / costs.steps) * quantity
  );
};

// TODO.generationLimit - Add a method to calculate generation limit bill (Will not affect buzz)
