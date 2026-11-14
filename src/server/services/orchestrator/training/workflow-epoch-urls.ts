import type { Workflow } from '@civitai/orchestration-client';

type TrainingStep = { $type?: string; input?: unknown; output?: unknown };

const isTrainingStep = (step: TrainingStep) =>
  step.$type === 'training' || step.$type === 'imageResourceTraining';

// Everything that names an epoch's weights: a url, or a blob id or name a url can be re-signed from.
const EPOCH_BLOB_KEYS = ['url', 'publicUrl', 'urlExpiresAt', 'id', 'jobId'];
const LEGACY_EPOCH_KEYS = ['blobUrl', 'blobName'];

const without = (value: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

/**
 * A training step without anything naming a run's weights: each epoch's weight blob, and the
 * epoch a continued run starts from (`input.continueFrom`). Epoch numbers and samples are kept.
 */
function withoutWeightHandles(step: TrainingStep): TrainingStep {
  const input = step.input as Record<string, unknown> | null | undefined;
  const output = step.output as { epochs?: unknown } | null | undefined;
  const epochs = Array.isArray(output?.epochs)
    ? output.epochs.map((epoch: unknown) => {
        if (!epoch || typeof epoch !== 'object') return epoch;
        const fields = epoch as Record<string, unknown>;
        if (step.$type === 'imageResourceTraining') return without(fields, LEGACY_EPOCH_KEYS);
        if (!fields.model || typeof fields.model !== 'object') return epoch;
        return {
          ...fields,
          model: without(fields.model as Record<string, unknown>, EPOCH_BLOB_KEYS),
        };
      })
    : undefined;
  return {
    ...step,
    ...(input && typeof input === 'object' ? { input: without(input, ['continueFrom']) } : {}),
    ...(epochs ? { output: { ...output, epochs } } : {}),
  };
}

/**
 * A workflow as a caller may see it: a training run's weights are reached through the model and
 * training views, which withhold a deleted or taken-down model's (`withoutEpochUrls`), so this read
 * names them to moderators only.
 */
export function withoutTrainingWeightHandles<W extends Workflow>(
  workflow: W,
  { isModerator }: { isModerator?: boolean }
): W {
  const steps = workflow?.steps as TrainingStep[] | undefined;
  if (isModerator || !steps?.some(isTrainingStep)) return workflow;
  return {
    ...workflow,
    steps: steps.map((step) => (isTrainingStep(step) ? withoutWeightHandles(step) : step)),
  } as W;
}
