import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { prettyTrainingBaseModel, trainingModelInfo } from '~/utils/training';

export type TrainingRunSummaryRow = { label: string; value: string };

export type TrainingRunSummary = {
  /** Human-readable base model, e.g. "SDXL" or "Mage-Flow 4B Base". */
  architecture: string | null;
  architectureKey: string | null;
  continuedFromEpoch: number | null;
  continuedFromVersionName: string | null;
  rows: TrainingRunSummaryRow[];
};

/** `baseModelType` is a family key — pony/illustrious/sdxl all report `sdxl` — so it can't tell
 * apart a multi-training batch. Prefer the specific `baseModel` key. */
export function trainingArchitectureKey(
  trainingDetails: TrainingDetailsObj | undefined | null
): string | null {
  const baseModel = trainingDetails?.baseModel;
  if (baseModel && baseModel in trainingModelInfo) return baseModel;
  return trainingDetails?.baseModelType ?? null;
}

/**
 * Kohya and AI Toolkit store the same knobs under different names (`unetLR`/`lr`,
 * `maxTrainEpochs`/`epochs`, `trainBatchSize`/`batchSize`), so a caller that reads one shape shows
 * blanks for the other. Labels match `trainingSettings` on the submit screen — the same value must
 * not be set under one name and read back under another. Copied rather than imported: this module
 * is also pulled into the epoch-download API route, and `trainingSettings` is in a `.tsx`.
 */
export function summarizeTrainingRun(
  trainingDetails: TrainingDetailsObj | undefined | null
): TrainingRunSummary {
  const params = trainingDetails?.params as Record<string, unknown> | undefined;
  const architectureKey = trainingArchitectureKey(trainingDetails);
  const pretty = prettyTrainingBaseModel(trainingDetails?.baseModel);

  const rows: TrainingRunSummaryRow[] = [];
  const add = (label: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    rows.push({ label, value: String(value) });
  };

  const num = (...keys: string[]) => {
    for (const key of keys) {
      const v = params?.[key];
      if (typeof v === 'number' && !Number.isNaN(v)) return v;
    }
    return undefined;
  };

  add('Engine', params?.engine);
  add('Steps', num('steps', 'targetSteps'));
  // AI Toolkit's `epochs` is its saved-checkpoint count, not an epoch count — the submit screen
  // labels the same knob "Checkpoints".
  if (params?.engine === 'ai-toolkit') add('Checkpoints', num('epochs', 'maxTrainEpochs'));
  else add('Epochs', num('maxTrainEpochs', 'epochs'));
  add('Resolution', num('resolution'));
  add('Train Batch Size', num('batchSize', 'trainBatchSize'));
  add('Unet LR', num('lr', 'unetLR'));
  add('Text Encoder LR', num('textEncoderLr', 'textEncoderLR'));
  add('Network Dim', num('networkDim'));
  add('Network Alpha', num('networkAlpha'));
  add('Optimizer', params?.optimizerType);
  add('LR Scheduler', params?.lrScheduler);

  return {
    architecture: pretty ?? architectureKey,
    architectureKey,
    continuedFromEpoch: trainingDetails?.continueFromEpoch?.epochNumber ?? null,
    continuedFromVersionName: trainingDetails?.continueFromEpoch?.sourceVersionName ?? null,
    rows,
  };
}
