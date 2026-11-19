import type {
  RemixAnswer,
  RemixAppSource,
  RemixAsk,
  RemixWorkflowRequest,
} from '~/shared/remix-apps/define';
import { firstAnswer, mockResult } from '~/shared/remix-apps/mock-host';
import {
  REMIX_RUN_LIMITS,
  RemixReplayError,
  type RemixLogEntry,
  type RemixReplayOutcome,
  type RemixReplayer,
} from '~/shared/remix-apps/replay';

export type RemixValidationIssue = {
  kind: 'refused' | 'error' | 'nondeterministic' | 'no-workflow' | 'too-many-paths';
  message: string;
  /** The answers that lead to it. */
  answers: RemixAnswer[];
};

/** Every path an app can take: each choice branches on every option. */
export type RemixGraphNode =
  | { type: 'workflow'; request: RemixWorkflowRequest; next: RemixGraphNode }
  | { type: 'ask'; spec: RemixAsk; branches: { answer: RemixAnswer; next: RemixGraphNode }[] }
  | { type: 'done'; outputs: number }
  | { type: 'stop'; issue: RemixValidationIssue };

export const REMIX_VALIDATE_MAX_PATHS = 32;

/** A stand-in source image: no real image is read or sent anywhere. */
export const VALIDATION_SOURCE: RemixAppSource = {
  imageId: 0,
  url: 'mock://remix/source',
  width: 1024,
  height: 1024,
};

/**
 * Dry-runs an app down every path with no orchestrator: each workflow gets placeholder images, a
 * pick its first image, a text ask a word, and a choice each of its options. `replay` is the
 * sandbox for a user app; this never runs an app's code itself.
 */
export async function validateRemixApp(
  replay: RemixReplayer,
  { source = VALIDATION_SOURCE, maxPaths = REMIX_VALIDATE_MAX_PATHS } = {}
) {
  const issues: RemixValidationIssue[] = [];
  let paths = 0;
  const stop = (issue: RemixValidationIssue): RemixGraphNode => {
    issues.push(issue);
    return { type: 'stop', issue };
  };

  async function outcomeOf(log: RemixLogEntry[], answers: RemixAnswer[]) {
    try {
      // Twice, because an app that is not a pure function of its log replays differently later.
      const [first, second] = [await replay(source, log), await replay(source, log)];
      if (JSON.stringify(first) !== JSON.stringify(second))
        return stop({
          kind: 'nondeterministic',
          message: 'Two replays of the same answers did different things',
          answers,
        });
      return first;
    } catch (error) {
      return stop({
        kind: error instanceof RemixReplayError ? 'refused' : 'error',
        message: (error as Error).message,
        answers,
      });
    }
  }

  async function walk(
    log: RemixLogEntry[],
    answers: RemixAnswer[],
    workflows: number
  ): Promise<RemixGraphNode> {
    // The replayer refuses a run past the limit too; this holds whatever replayer is passed in.
    if (log.length > REMIX_RUN_LIMITS.effects) {
      paths++;
      return stop({
        kind: 'refused',
        message: `More than ${REMIX_RUN_LIMITS.effects} steps`,
        answers,
      });
    }
    const outcome: RemixReplayOutcome | RemixGraphNode = await outcomeOf(log, answers);
    if ('type' in outcome) {
      paths++;
      return outcome;
    }
    if (outcome.status === 'done') {
      paths++;
      // Answers given before the first workflow are recorded on it, so a path without one loses them.
      if (!workflows)
        return stop({
          kind: 'no-workflow',
          message: 'Finishes without running a workflow',
          answers,
        });
      return { type: 'done', outputs: outcome.outputs.length };
    }
    const { effect, index } = outcome;
    if (effect.type === 'workflow') {
      const result = mockResult(effect.request, index);
      const next = await walk([...log, { type: 'workflow', result }], answers, workflows + 1);
      return { type: 'workflow', request: effect.request, next };
    }
    const options =
      effect.spec.kind === 'choice'
        ? effect.spec.options.map((option) => option.value)
        : [firstAnswer(effect.spec)];
    const branches: { answer: RemixAnswer; next: RemixGraphNode }[] = [];
    for (const answer of options) {
      if (paths >= maxPaths) {
        if (!issues.some((issue) => issue.kind === 'too-many-paths'))
          issues.push({
            kind: 'too-many-paths',
            message: `More than ${maxPaths} paths; the rest were not checked`,
            answers,
          });
        break;
      }
      const next = await walk([...log, { type: 'ask', answer }], [...answers, answer], workflows);
      branches.push({ answer, next });
    }
    return { type: 'ask', spec: effect.spec, branches };
  }

  const graph = await walk([], [], 0);
  return { graph, paths, issues };
}