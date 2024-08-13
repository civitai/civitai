import JSZip from 'jszip';
import { constants } from '~/server/common/constants';
import { getMimeTypeFromExt, IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { TrainingCost } from '~/server/schema/training.schema';
import { getFileExtension } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';

export const trainingBaseModelType = ['sd15', 'sdxl', 'flux'] as const;
export type TrainingBaseModelType = (typeof trainingBaseModelType)[number];

// Default costs have moved to `training.schema.ts`
// Costs are now overridable via redis `system:features` hset `training:status` key.
export const calcEta = ({
  cost,
  baseModel: model,
  targetSteps: steps,
}: {
  cost: TrainingCost;
  baseModel: TrainingBaseModelType;
  targetSteps: number;
}) => {
  if (!model) return;
  if (!trainingBaseModelType.includes(model)) {
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
  isPriority,
}: {
  cost: TrainingCost;
  eta: number | undefined;
  isCustom: boolean;
  isPriority: boolean;
}) => {
  if (!eta) return cost.baseBuzz;

  const computedCost = eta * (cost.hourlyCost / 60) * constants.buzz.buzzDollarRatio;
  let buzz = Math.max(cost.baseBuzz, computedCost);
  if (isCustom) buzz += cost.customModelBuzz;
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
