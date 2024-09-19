import JSZip from 'jszip';
import { constants } from '~/server/common/constants';
import { getMimeTypeFromExt, IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { EngineTypes, TrainingDetailsParams } from '~/server/schema/model-version.schema';
import { TrainingCost } from '~/server/schema/training.schema';
import { getFileExtension } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

export const trainingBaseModelType = ['sd15', 'sdxl', 'flux'] as const;
export type TrainingBaseModelType = (typeof trainingBaseModelType)[number];

export const rapidEta = 5;

// Default costs have moved to `training.schema.ts`
// Costs are now overridable via redis `system:features` hset `training:status` key.
export const calcEta = ({
  cost,
  baseModel: model,
  params,
}: {
  cost: TrainingCost;
  baseModel: TrainingBaseModelType;
  params: TrainingDetailsParams;
}) => {
  if (!model) return;
  if (!trainingBaseModelType.includes(model)) {
    model = 'sd15';
  }

  if (isValidRapid(model, params.engine)) return rapidEta;

  const modelCoeffs = cost.modelCoefficients[model];
  const resolutionCoeff = Math.max(1, params.resolution / modelCoeffs.resolutionBase);

  const computedEta =
    (modelCoeffs.base +
      modelCoeffs.steps * modelCoeffs.stepMultiplier * params.targetSteps +
      Math.E ** ((modelCoeffs.expStrength * params.targetSteps) / modelCoeffs.expStart)) *
    resolutionCoeff;

  return Math.max(cost.minEta, computedEta);
};

export const calcBuzzFromEta = ({
  cost,
  eta,
  isCustom,
  isFlux,
  isPriority,
  isRapid,
  numImages,
}: {
  cost: TrainingCost;
  eta: number | undefined;
  isCustom: boolean;
  isFlux: boolean;
  isPriority: boolean;
  isRapid: boolean;
  numImages: number;
}) => {
  if (isRapid) {
    let baseCost = cost.rapid.baseBuzz;
    if (isValidDiscount(cost)) {
      try {
        baseCost *= cost.rapid.discountFactor ?? 1;
      } catch (e) {}
    }

    const imgCost =
      Math.max(0, Math.ceil((numImages - cost.rapid.numImgBase) / cost.rapid.numImgStep)) *
      cost.rapid.numImgBuzz;

    return isNaN(imgCost) ? baseCost : baseCost + imgCost;
  }

  if (!eta) return cost.baseBuzz;

  const computedCost = eta * (cost.hourlyCost / 60) * constants.buzz.buzzDollarRatio;
  let buzz = Math.max(cost.baseBuzz, computedCost);
  if (isCustom) buzz += cost.customModelBuzz;
  if (isFlux) buzz += cost.fluxBuzz;
  if (isPriority) buzz += Math.max(cost.priorityBuzz, cost.priorityBuzzPct * buzz);
  return Math.round(buzz);
};

export async function unzipTrainingData<T = void>(
  zData: JSZip,
  cb: (args: { imgBlob: Blob; filename: string; fileExt: string }) => Promise<T> | T
) {
  return (
    await Promise.all(
      Object.entries(zData.files).map(async ([zname, zf]) => {
        if (zf.dir) return;
        if (zname.startsWith('__MACOSX/') || zname.endsWith('.DS_STORE')) return;

        const fileExt = getFileExtension(zname);
        const mimeType = getMimeTypeFromExt(fileExt);
        if (!IMAGE_MIME_TYPE.includes(mimeType as any)) return;
        const imgBlob = await zf.async('blob');
        return await cb({ imgBlob, filename: zname, fileExt });
      })
    )
  ).filter(isDefined);
}

export const isValidRapid = (baseModel: TrainingBaseModelType, engine: EngineTypes) => {
  return baseModel === 'flux' && engine === 'rapid';
};

export const isInvalidRapid = (baseModel: TrainingBaseModelType, engine: EngineTypes) => {
  return baseModel !== 'flux' && engine === 'rapid';
};

export const orchRapidEngine = 'flux-dev-fast';

export const isValidDiscount = (cost: TrainingCost) => {
  const now = new Date();
  try {
    return (
      isDefined(cost.rapid.discountFactor) &&
      cost.rapid.discountFactor < 1 &&
      cost.rapid.discountFactor >= 0 &&
      isDefined(cost.rapid.discountStart) &&
      isDefined(cost.rapid.discountEnd) &&
      new Date(cost.rapid.discountStart) <= now &&
      new Date(cost.rapid.discountEnd) > now
    );
  } catch {
    return false;
  }
};
