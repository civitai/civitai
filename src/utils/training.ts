import { constants } from '~/server/common/constants';
import { TrainingCost } from '~/server/schema/training.schema';

// Default costs have moved to `training.schema.ts`
// Costs are now overridable via redis `system:features` hset `training:status` key.
export const calcEta = ({
  cost,
  baseModel: model,
  targetSteps: steps,
}: {
  cost: TrainingCost;
  baseModel: 'sd15' | 'sdxl';
  targetSteps: number;
}) => {
  if (!model) return;
  if (model !== 'sd15' && model !== 'sdxl') {
    model = 'sd15';
  }

  const modelCoeffs = cost.modelCoefficients[model];
  const computedEta =
    modelCoeffs.base +
    modelCoeffs.steps * modelCoeffs.stepMultiplier * steps +
    Math.E ** ((modelCoeffs.expStrength * steps) / modelCoeffs.expStart);

  return Math.max(cost.minEta, computedEta);
};

export const calcBuzzFromEta = ({
  cost,
  eta,
  isCustom,
}: {
  cost: TrainingCost;
  eta: number | undefined;
  isCustom: boolean;
}) => {
  if (!eta) return cost.baseBuzz;

  const computedCost = eta * (cost.hourlyCost / 60) * constants.buzz.buzzDollarRatio;
  let buzz = Math.max(cost.baseBuzz, computedCost);
  if (isCustom) buzz += cost.customModelBuzz;
  return Math.round(buzz);
};
