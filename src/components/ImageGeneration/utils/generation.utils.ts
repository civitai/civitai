import { generation, GenerationBaseModel, getGenerationConfig } from '~/server/common/constants';
import { GenerateFormModel } from '~/server/schema/generation.schema';
import { isNumber } from '~/utils/type-guards';

export const calculateGenerationBill = (data: Partial<GenerateFormModel>) => {
  const {
    quantity = generation.defaultValues.quantity,
    steps = generation.defaultValues.steps,
    aspectRatio = generation.defaultValues.aspectRatio,
    baseModel = 'SD1',
  } = data;

  const aspectRatios = getGenerationConfig(baseModel).aspectRatios;
  const aspectRatioNum = Number(
    isNumber(aspectRatio) ? aspectRatio : generation.defaultValues.aspectRatio
  );
  const { width, height } = aspectRatios[aspectRatioNum];

  return Math.ceil(
    generation.settingsCost.base *
      generation.settingsCost.baseModel[baseModel as GenerationBaseModel] *
      (width / generation.settingsCost.width) *
      (height / generation.settingsCost.height) *
      (steps / generation.settingsCost.steps) *
      quantity
  );
};
