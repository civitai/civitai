import { isTrainingStepTypeIgnoringCase } from '~/server/services/blocks/steps/orchestrator-denylist';
import { studioWithheldWorkflowIds } from '~/server/services/orchestrator/training/studio-withheld';

type StepLike = { $type?: string; name?: string; status?: unknown };
type WorkflowLike = { id?: string | null; steps?: StepLike[] | null };

// Any casing, as the weight-handle strip (workflow-epoch-urls) reads it.
const isTrainingStep = (step: StepLike) =>
  typeof step.$type === 'string' && isTrainingStepTypeIgnoringCase(step.$type);

// Only these survive on a withheld training step: its input, output and metadata can each carry
// the run's epoch keys and URLs.
const withheldStep = ({ $type, name, status }: StepLike) => ({ $type, name, status });

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
          steps: w.steps?.map((s) => (isTrainingStep(s) ? withheldStep(s) : s)),
        }
      : w
  );
}
