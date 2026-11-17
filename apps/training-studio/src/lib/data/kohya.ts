import type { KohyaTrainingInputWritable } from '@civitai/orchestration-client';
import {
  TARGET_STEPS,
  type ModelVersionInfo,
  type ParamBound,
  type RunParamDefaults,
} from './trainingModels';

export type KohyaInput = Omit<KohyaTrainingInputWritable, 'usesStepPricing'>;
export type KohyaOptions = Partial<
  Pick<
    KohyaInput,
    | 'numRepeats'
    | 'enableBucket'
    | 'clipSkip'
    | 'lrSchedulerNumCycles'
    | 'seed'
    | 'fp8Base'
    | 'blocksToSwap'
    | 'vParameterization'
    | 'zeroTerminalSnr'
  >
>;

export const KOHYA_OPTIMIZERS = [
  'AdamW',
  'AdamW8bit',
  'Adafactor',
  'Prodigy',
  'Lion',
  'Lion8bit',
] satisfies KohyaInput['optimizerType'][];

export const KOHYA_SCHEDULERS = [
  'constant',
  'constant_with_warmup',
  'cosine',
  'cosine_with_restarts',
  'linear',
  'polynomial',
] satisfies KohyaInput['lrScheduler'][];

export function kohyaFamily(ecosystem: string): 'sd1' | 'sdxl' | 'flux1' | 'chroma' | undefined {
  switch (ecosystem) {
    case 'sd1':
      return 'sd1';
    case 'sdxl':
    case 'pony':
    case 'illustrious':
    case 'noobai':
      return 'sdxl';
    case 'flux1':
      return 'flux1';
    case 'chroma':
      return 'chroma';
    default:
      return undefined;
  }
}

export const isKohyaFlow = (ecosystem: string): boolean =>
  ecosystem === 'flux1' || ecosystem === 'chroma';

export function kohyaDefaults(version: ModelVersionInfo): RunParamDefaults {
  const sd1 = version.ecosystem === 'sd1';
  const flow = isKohyaFlow(version.ecosystem);
  const pony = version.key === 'pony';
  const anime = version.key === 'anime';
  return {
    epochs: flow ? 5 : 10,
    unetLr: pony ? 1 : 5e-4,
    textEncoderLr: flow ? 0 : pony ? 1 : anime ? 1e-4 : 5e-5,
    networkDim: anime ? 16 : 32,
    networkAlpha: anime ? 8 : version.key === 'flux_dev' ? 2 : 16,
    resolution: sd1 ? 512 : 1024,
    batchSize: flow ? 1 : version.key === 'realistic' ? 2 : sd1 ? 6 : pony ? 5 : 4,
    noiseOffset: flow ? 0 : pony ? 0.03 : 0.1,
    lrScheduler: pony ? 'cosine' : 'cosine_with_restarts',
    optimizer: pony ? 'Prodigy' : !sd1 && !flow ? 'Adafactor' : 'AdamW8bit',
  };
}

export const KOHYA_BOUNDS: Record<string, ParamBound> = {
  steps: { ...TARGET_STEPS, step: 1 },
  minSnrGamma: { min: 0, max: 20, step: 1 },
  noiseOffset: { min: 0, max: 1, step: 0.01 },
  keepTokens: { min: 0, max: 3, step: 1 },
  epochs: { min: 1, max: 20, step: 1 },
  batchSize: { min: 1, max: 9, step: 1 },
  unetLr: { min: 1e-9, max: 1, step: 1e-5 },
  textEncoderLr: { min: 0, max: 1, step: 1e-5 },
  networkDim: { min: 1, max: 256, step: 1 },
  networkAlpha: { min: 1, max: 256, step: 1 },
  resolution: { min: 512, max: 1024, step: 64 },
  numRepeats: { min: 1, max: 5000, step: 1 },
  clipSkip: { min: 1, max: 4, step: 1 },
  lrSchedulerNumCycles: { min: 1, max: 4, step: 1 },
  seed: { min: 0, max: 2147483647, step: 1 },
  blocksToSwap: { min: 0, max: 35, step: 1 },
};

export const KOHYA_PARAM_FIELDS = [
  'negativePrompt',
  'numRepeats',
  'enableBucket',
  'clipSkip',
  'lrSchedulerNumCycles',
  'seed',
  'fp8Base',
  'blocksToSwap',
  'vParameterization',
  'zeroTerminalSnr',
] as const;

export function kohyaFieldSupported(field: string, ecosystem: string): boolean {
  if (field === 'negativePrompt') return ecosystem !== 'flux1';
  if (field === 'clipSkip') return ecosystem === 'sd1';
  if (field === 'fp8Base' || field === 'blocksToSwap') return isKohyaFlow(ecosystem);
  if (field === 'vParameterization' || field === 'zeroTerminalSnr') return !isKohyaFlow(ecosystem);
  return true;
}
