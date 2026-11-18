import { Air, type BlobsTrainingData, type ZipTrainingData } from '@civitai/orchestration-client';
import {
  KOHYA_BOUNDS,
  KOHYA_OPTIMIZERS,
  KOHYA_SCHEDULERS,
  isKohyaFlow,
  kohyaFamily,
  type KohyaInput,
} from './data/kohya';
import type { TrainingRunInput } from './train-core';
import { withTrigger } from './training-trigger';

export type KohyaRunParams = Pick<
  TrainingRunInput,
  | 'unetLr'
  | 'textEncoderLr'
  | 'networkDim'
  | 'networkAlpha'
  | 'resolution'
  | 'batchSize'
  | 'lrScheduler'
  | 'optimizer'
  | 'shuffleTokens'
  | 'keepTokens'
  | 'minSnrGamma'
  | 'noiseOffset'
  | 'flipAugmentation'
  | 'kohya'
  | 'negativePrompt'
>;

export function buildKohyaInput(
  run: Omit<TrainingRunInput, 'items' | 'meta'>,
  trainingData: BlobsTrainingData | ZipTrainingData,
  trace: string
): KohyaInput {
  const model = run.customModel ?? run.model;
  const modelAir = model ? Air.parseSafe(model) : undefined;
  const family = kohyaFamily(run.ecosystem);
  if (
    !family ||
    !modelAir ||
    modelAir.type !== 'checkpoint' ||
    kohyaFamily(modelAir.ecosystem) !== family
  )
    throw new Error('Choose a compatible Kohya checkpoint for this model family.');
  const optimizerType = KOHYA_OPTIMIZERS.find(
    (x) => x.toLowerCase() === run.optimizer.toLowerCase()
  );
  const lrScheduler = KOHYA_SCHEDULERS.find((x) => x === run.lrScheduler);
  if (!optimizerType || !lrScheduler) throw new Error('Unsupported Kohya optimizer or scheduler.');
  if (run.editTraining || run.sourceImages?.length)
    throw new Error('Kohya does not support image-edit datasets.');
  const flow = isKohyaFlow(family);
  const settings = run.kohya;
  const prodigy = optimizerType === 'Prodigy';
  const textEncoderLR =
    family === 'chroma' ? 0 : run.textEncoderLr > 0 && prodigy ? 1 : run.textEncoderLr;
  const numeric = {
    steps: run.steps,
    epochs: run.epochs,
    batchSize: run.batchSize,
    resolution: run.resolution,
    networkDim: run.networkDim,
    networkAlpha: run.networkAlpha,
    unetLr: prodigy ? 1 : run.unetLr,
    textEncoderLr: textEncoderLR,
    numRepeats: settings?.numRepeats ?? 1,
    clipSkip: family === 'sd1' ? settings?.clipSkip ?? 1 : 1,
    lrSchedulerNumCycles: settings?.lrSchedulerNumCycles ?? 3,
    seed: settings?.seed ?? 42,
    keepTokens: run.keepTokens ?? 0,
    minSnrGamma: flow ? 0 : run.minSnrGamma ?? 5,
    noiseOffset: flow ? 0 : run.noiseOffset ?? 0,
    blocksToSwap: flow ? settings?.blocksToSwap ?? 18 : 0,
  };
  for (const [name, value] of Object.entries(numeric)) {
    const { min, max, step } = KOHYA_BOUNDS[name]!;
    const integer = step >= 1;
    if (
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    )
      throw new Error(
        `Kohya ${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`
      );
  }
  if (run.resolution % 64 !== 0) throw new Error('Kohya resolution must be a multiple of 64.');
  for (const key of ['enableBucket', 'fp8Base', 'vParameterization', 'zeroTerminalSnr'] as const)
    if (settings?.[key] != null && typeof settings[key] !== 'boolean')
      throw new Error(`Kohya ${key} must be a boolean.`);
  const data =
    trainingData.type === 'blobs'
      ? {
          ...trainingData,
          items: trainingData.items.map((item) => ({
            ...item,
            caption: withTrigger(run.trigger, item.caption ?? ''),
          })),
        }
      : trainingData;
  return {
    engine: 'kohya',
    model: model!,
    steps: run.steps,
    maxTrainEpochs: run.epochs,
    numRepeats: settings?.numRepeats ?? 1,
    trainBatchSize: run.batchSize,
    resolution: run.resolution,
    enableBucket: settings?.enableBucket ?? true,
    shuffleCaption: run.shuffleTokens ?? false,
    keepTokens: run.keepTokens ?? 0,
    clipSkip: family === 'sd1' ? settings?.clipSkip ?? 1 : 1,
    flipAugmentation: run.flipAugmentation ?? false,
    unetLR: prodigy ? 1 : run.unetLr,
    textEncoderLR,
    trainTextEncoder: textEncoderLR > 0,
    lrScheduler,
    lrSchedulerNumCycles: settings?.lrSchedulerNumCycles ?? 3,
    minSnrGamma: flow ? 0 : run.minSnrGamma ?? 5,
    networkDim: run.networkDim,
    networkAlpha: run.networkAlpha,
    noiseOffset: flow ? 0 : run.noiseOffset ?? 0,
    optimizerType,
    seed: settings?.seed ?? 42,
    trace: trace === 'logs' || trace === 'none' ? trace : 'events',
    ...(flow
      ? { fp8Base: settings?.fp8Base ?? true, blocksToSwap: settings?.blocksToSwap ?? 18 }
      : {}),
    ...(!flow && settings?.vParameterization != null
      ? { vParameterization: settings.vParameterization }
      : {}),
    ...(!flow && settings?.zeroTerminalSnr != null
      ? { zeroTerminalSnr: settings.zeroTerminalSnr }
      : {}),
    ...(run.continueFrom ? { continueFrom: run.continueFrom } : {}),
    trainingData: data,
    samples: {
      prompts: run.prompts,
      ...(family !== 'flux1' && run.negativePrompt?.trim()
        ? { negativePrompt: run.negativePrompt.trim() }
        : {}),
    },
  };
}
