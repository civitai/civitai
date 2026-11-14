import type { Workflow } from '@civitai/orchestration-client';
import { isTrainingStepTypeIgnoringCase } from '~/server/services/blocks/steps/orchestrator-denylist';
import { WORKFLOW_ARGUMENTS_REF } from '~/server/services/blocks/workflow-graph';

type TrainingStep = {
  $type?: string;
  input?: unknown;
  output?: unknown;
  preparation?: unknown;
  metadata?: unknown;
};

const isTrainingStep = (step: TrainingStep) =>
  typeof step.$type === 'string' && isTrainingStepTypeIgnoringCase(step.$type);

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
 * Epoch numbers and sample images are kept.
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

/** Every `$ref` an input names, at any depth. */
function refsIn(value: unknown, refs = new Set<string>(), depth = 0): Set<string> {
  if (depth > 32 || !value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) {
    for (const item of value) refsIn(item, refs, depth + 1);
    return refs;
  }
  const fields = value as Record<string, unknown>;
  if (typeof fields.$ref === 'string') refs.add(fields.$ref);
  for (const child of Object.values(fields)) refsIn(child, refs, depth + 1);
  return refs;
}

/** The loop variables (`for.as`) a `repeat` declares, at any depth. */
function loopVarsIn(value: unknown, vars = new Set<string>(), depth = 0): Set<string> {
  if (depth > 32 || !value || typeof value !== 'object') return vars;
  if (Array.isArray(value)) {
    for (const item of value) loopVarsIn(item, vars, depth + 1);
    return vars;
  }
  const fields = value as Record<string, unknown>;
  const forClause = fields.for as { as?: unknown } | undefined;
  if (forClause && typeof forClause === 'object' && typeof forClause.as === 'string')
    vars.add(forClause.as);
  for (const child of Object.values(fields)) loopVarsIn(child, vars, depth + 1);
  return vars;
}

/** Whether an input runs a training step itself, as a `repeat` template does, at any depth. */
function runsTraining(value: unknown, depth = 0): boolean {
  if (depth > 32 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => runsTraining(item, depth + 1));
  const fields = value as Record<string, unknown>;
  if (typeof fields.$type === 'string' && isTrainingStepTypeIgnoringCase(fields.$type)) return true;
  return Object.values(fields).some((child) => runsTraining(child, depth + 1));
}

/**
 * A workflow as a caller may see it: a training run's weights are reached through the model and
 * training views, which withhold a deleted or taken-down model's (`withoutEpochUrls`), so this read
 * names them to moderators only. A training step loses its handles; a step that runs one (a
 * `repeat`), or reads from such a step directly or through others, loses its output and metadata,
 * as does a step reading a step the workflow does not name.
 */
export function withoutTrainingWeightHandles<W extends Workflow>(
  workflow: W,
  { isModerator }: { isModerator?: boolean }
): W {
  const steps = workflow?.steps as (TrainingStep & { name?: unknown })[] | undefined;
  if (isModerator || !steps?.length) return workflow;
  // A `$ref` names an earlier step, the workflow's arguments, or a `repeat`'s loop variable.
  const names = new Set<unknown>([
    WORKFLOW_ARGUMENTS_REF,
    ...steps.map((step) => step.name),
    ...steps.flatMap((step) => [...loopVarsIn(step.input)]),
  ]);
  const tainted = new Set<number>();
  steps.forEach((step, index) => {
    if (isTrainingStep(step) || runsTraining(step.input)) tainted.add(index);
  });
  if (!tainted.size) return workflow;
  const refs = steps.map((step) => refsIn(step.input));
  for (let changed = true; changed; ) {
    changed = false;
    steps.forEach((_step, index) => {
      if (tainted.has(index)) return;
      const reads = [...refs[index]];
      if (
        reads.some(
          (ref) => !names.has(ref) || steps.some((s, j) => tainted.has(j) && s.name === ref)
        )
      ) {
        tainted.add(index);
        changed = true;
      }
    });
  }
  return {
    ...workflow,
    steps: steps.map((step, index) => {
      if (!tainted.has(index)) return step;
      if (isTrainingStep(step)) return withoutWeightHandles(step);
      const { output: _output, preparation: _preparation, metadata: _metadata, ...rest } = step;
      return rest;
    }),
  } as W;
}
