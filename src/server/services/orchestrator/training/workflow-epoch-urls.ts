import type { Workflow } from '@civitai/orchestration-client';

type TrainingStep = {
  $type?: string;
  input?: unknown;
  output?: unknown;
  preparation?: unknown;
  metadata?: unknown;
};

const isTrainingStep = (step: TrainingStep) =>
  step.$type === 'training' || step.$type === 'imageResourceTraining';

// Everything that names an epoch's weights: a url, a blob id, job or name a url can be re-signed
// from, or the run's trace. Both epoch shapes are cleared whatever the step's type.
const EPOCH_KEYS = ['blobUrl', 'blobName', 'traceUrl'];
const BLOB_KEYS = ['url', 'publicUrl', 'urlExpiresAt', 'id', 'jobId'];

const without = (value: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

const withoutJob = (blob: unknown) =>
  blob && typeof blob === 'object' ? without(blob as Record<string, unknown>, ['jobId']) : blob;

/**
 * A training step without anything naming a run's weights: each epoch's weight blob and trace, the
 * epoch a continued run starts from (`input.continueFrom`), the resources it is preparing, and any
 * metadata but its model file.
 * Epoch numbers and samples are kept.
 */
function withoutWeightHandles(step: TrainingStep): TrainingStep {
  const input = step.input as Record<string, unknown> | null | undefined;
  const output = step.output as { epochs?: unknown } | null | undefined;
  const epochs = Array.isArray(output?.epochs)
    ? output.epochs.map((epoch: unknown) => {
        if (!epoch || typeof epoch !== 'object') return epoch;
        const fields = without(epoch as Record<string, unknown>, EPOCH_KEYS);
        if (fields.model && typeof fields.model === 'object')
          fields.model = without(fields.model as Record<string, unknown>, BLOB_KEYS);
        if (Array.isArray(fields.samples)) fields.samples = fields.samples.map(withoutJob);
        return fields;
      })
    : undefined;
  const { preparation: _preparation, ...rest } = step;
  // Step metadata is the owner's to write; only the model file the server stamps is kept.
  const metadata = step.metadata as { modelFileId?: unknown } | null | undefined;
  return {
    ...rest,
    ...(metadata && typeof metadata === 'object'
      ? {
          metadata: metadata.modelFileId !== undefined ? { modelFileId: metadata.modelFileId } : {},
        }
      : {}),
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
