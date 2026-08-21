import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { trainingModelInfo } from '~/utils/training';

export type TrainingRunSummaryRow = { label: string; value: string };

export type TrainingRunSummary = {
  /** Human-readable base model, e.g. "SDXL" or "Mage-Flow 4B Base". */
  architecture: string | null;
  architectureKey: string | null;
  continuedFromEpoch: number | null;
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
 * blanks for the other.
 */
export function summarizeTrainingRun(
  trainingDetails: TrainingDetailsObj | undefined | null
): TrainingRunSummary {
  const params = trainingDetails?.params as Record<string, unknown> | undefined;
  const baseModel = trainingDetails?.baseModel;
  const architectureKey = trainingArchitectureKey(trainingDetails);

  const pretty = baseModel
    ? (trainingModelInfo as Record<string, { pretty?: string } | undefined>)[baseModel]?.pretty
    : undefined;

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
  add('Epochs', num('epochs', 'maxTrainEpochs'));
  add('Resolution', num('resolution'));
  add('Batch size', num('batchSize', 'trainBatchSize'));
  add('Learning rate', num('lr', 'unetLR'));
  add('Text encoder LR', num('textEncoderLr', 'textEncoderLR'));
  add(
    'Network dim / alpha',
    (() => {
      const dim = num('networkDim');
      const alpha = num('networkAlpha');
      if (dim === undefined && alpha === undefined) return undefined;
      return `${dim ?? '—'} / ${alpha ?? '—'}`;
    })()
  );
  add('Optimizer', params?.optimizerType);
  add('Scheduler', params?.lrScheduler);

  return {
    architecture: pretty ?? architectureKey,
    architectureKey,
    continuedFromEpoch: trainingDetails?.continueFromEpoch?.epochNumber ?? null,
    rows,
  };
}
