import { GenerateFormModel } from '~/server/schema/generation.schema';
import { GenerationBaseModel, generation, getGenerationConfig } from '~/server/common/constants';

export const calculateGenerationBill = (data: Partial<GenerateFormModel>) => {
  const {
    quantity = generation.defaultValues.quantity,
    steps = generation.defaultValues.steps,
    aspectRatio = generation.defaultValues.aspectRatio,
    baseModel = 'SD1',
  } = data;

  const aspectRatios = getGenerationConfig(baseModel).aspectRatios;
  const { width, height } = aspectRatios[Number(aspectRatio)];

  return Math.ceil(
    generation.settingsCost.base *
      generation.settingsCost.baseModel[baseModel as GenerationBaseModel] *
      (width / generation.settingsCost.width) *
      (height / generation.settingsCost.height) *
      (steps / generation.settingsCost.steps) *
      quantity
  );
};
