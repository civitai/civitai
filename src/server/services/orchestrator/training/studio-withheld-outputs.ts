import { studioWithheldWorkflowIds } from '~/server/services/orchestrator/training/studio-withheld';

const TRAINING_STEP_TYPES = new Set(['training', 'imageResourceTraining']);

type StepLike = { $type?: string; output?: unknown };
type WorkflowLike = { id?: string | null; steps?: StepLike[] | null };

const isTrainingStep = (step: StepLike) => TRAINING_STEP_TYPES.has(step.$type ?? '');

/**
 * The caller's workflows as the generic workflow reads return them, with the training-step outputs
 * (epoch weights and samples) of a withheld run removed. Moderators see everything.
 */
export async function withholdTrainingOutputs<W extends WorkflowLike>(
  user: { id: number; isModerator?: boolean },
  workflows: W[]
): Promise<W[]> {
  if (user.isModerator) return workflows;
  const ids = workflows.flatMap((w) => (w.id && w.steps?.some(isTrainingStep) ? [w.id] : []));
  if (ids.length === 0) return workflows;
  const withheld = new Set(await studioWithheldWorkflowIds(user.id, ids));
  if (withheld.size === 0) return workflows;
  return workflows.map((w) =>
    w.id && withheld.has(w.id)
      ? {
          ...w,
          steps: w.steps?.map((s) => (isTrainingStep(s) ? { ...s, output: undefined } : s)),
        }
      : w
  );
}
