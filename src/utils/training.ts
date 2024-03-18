import { constants } from '~/server/common/constants';
import { TrainingDetailsBaseModel } from '~/server/schema/model-version.schema';
import { TrainingCost } from '~/server/schema/training.schema';

// Default costs have moved to `training.schema.ts`
// Costs are now overridable via redis `system:features` hset `training:status` key.
export const calcEta = ({
  networkDim: dim,
  networkAlpha: alpha,
  targetSteps: steps,
  baseModel: model,
  cost,
}: {
  networkDim: number;
  networkAlpha: number;
  targetSteps: number;
  baseModel: TrainingDetailsBaseModel | null;
  cost: TrainingCost;
}) => {
  if (!model) return;

  const modelCoeff = cost.etaCoefficients.models[model] ?? cost.baseModelCoeff;
  const computedEta =
    modelCoeff +
    cost.etaCoefficients.alpha * alpha +
    cost.etaCoefficients.dim * dim +
    (cost.etaCoefficients.steps * cost.stepsCoeff * steps) ** cost.stepsExp;
  return Math.max(cost.minEta, computedEta);
};

export const calcBuzzFromEta = ({
  eta,
  isCustom,
  cost,
}: {
  eta: number;
  isCustom: boolean;
  cost: TrainingCost;
}) => {
  const computedCost = eta * (cost.hourlyCost / 60) * constants.buzz.buzzDollarRatio;
  let buzz = Math.max(cost.baseBuzz, computedCost);
  if (isCustom) buzz += cost.customModelBuzz;
  return Math.round(buzz);
};
