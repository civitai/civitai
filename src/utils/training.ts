import {
  TrainingDetailsBaseModel,
  TrainingDetailsBaseModelList,
} from '~/server/schema/model-version.schema';

const baseModelCoeff = 0;

const etaCoefficients = {
  models: {
    sdxl: 19.42979334,
    pony: 19.42979334,
    sd_1_5: -25.38624804,
    anime: -23.84022578,
    semi: -20.56343578,
    realistic: -50.28902011,
  },
  alpha: -0.649960841,
  dim: 0.792224422,
  steps: 0.014458002,
};

const dollarsPerMinute = 0.44 / 60;
const dollarsToBuzz = 1000;
const baseBuzzTake = 500;
const minEta = 1;

export const calcEta = (
  dim: number,
  alpha: number,
  steps: number,
  model: TrainingDetailsBaseModel | null
) => {
  if (!model) return;

  const modelCoeff =
    model in etaCoefficients.models
      ? etaCoefficients.models[model as TrainingDetailsBaseModelList]
      : baseModelCoeff;

  return Math.max(
    minEta,
    modelCoeff +
      etaCoefficients.alpha * alpha +
      etaCoefficients.dim * dim +
      etaCoefficients.steps * steps
  );
};

// TODO base cost for custom
export const calcBuzzFromEta = (eta: number) => {
  return Math.round(Math.max(baseBuzzTake, eta * dollarsPerMinute * dollarsToBuzz));
};
