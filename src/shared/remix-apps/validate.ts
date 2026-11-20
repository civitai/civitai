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

/**
 * Replays `base`, then `base` followed by each of `branches`, in one go, as a sandbox call does.
 * An app's own fault comes back in its place as a `RemixReplayError`.
 */
export type RemixBranchReplayer = (
  source: RemixAppSource,
  base: readonly RemixLogEntry[],
  branches: readonly (readonly RemixLogEntry[])[]
) => Promise<(RemixReplayOutcome | RemixReplayError)[]>;

/** The runner's `MAX_REMIX_BRANCHES`. */
const BRANCHES_PER_CALL = 12;

type Replayed = RemixReplayOutcome | RemixReplayError;

const inPlace = (replay: RemixReplayer, source: RemixAppSource, log: RemixLogEntry[]) =>
  replay(source, log).catch((error: unknown) => {
    if (error instanceof RemixReplayError) return error;
    throw error;
  });

/** One replay at a time, for a replayer that answers one log per call. */
const oneByOne =
  (replay: RemixReplayer): RemixBranchReplayer =>
  async (source, base, branches) => {
    const results: Replayed[] = [];
    for (const branch of [[], ...branches])
      results.push(await inPlace(replay, source, [...base, ...branch]));
    return results;
  };

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
  replay: RemixReplayer | { branches: RemixBranchReplayer },
  { source = VALIDATION_SOURCE, maxPaths = REMIX_VALIDATE_MAX_PATHS } = {}
) {
  const replayBranches = typeof replay === 'function' ? oneByOne(replay) : replay.branches;
  const issues: RemixValidationIssue[] = [];
  let paths = 0;
  const stop = (issue: RemixValidationIssue): RemixGraphNode => {
    issues.push(issue);
    return { type: 'stop', issue };
  };

  const shown = (r: Replayed) => JSON.stringify(r instanceof RemixReplayError ? r.message : r);

  /**
   * The outcome after `log` and each of `answered`, as few calls as the branches allow. Each is
   * replayed twice, because an app that is not a pure function of its log replays differently later.
   */
  async function outcomesOf(
    log: RemixLogEntry[],
    answered: { answer: RemixAnswer | null; answers: RemixAnswer[] }[]
  ): Promise<(RemixReplayOutcome | RemixGraphNode)[]> {
    const suffixes = answered.map(({ answer }): RemixLogEntry[] =>
      answer === null ? [] : [{ type: 'ask', answer }]
    );
    const twice = suffixes.flatMap((suffix) => [suffix, suffix]);
    const replayed: Replayed[] = [];
    try {
      for (let i = 0; i < twice.length; i += BRANCHES_PER_CALL)
        replayed.push(
          ...(await replayBranches(source, log, twice.slice(i, i + BRANCHES_PER_CALL))).slice(1)
        );
    } catch (error) {
      return answered.map(({ answers }) =>
        stop({ kind: 'error', message: (error as Error).message, answers })
      );
    }
    return answered.map(({ answers }, i) => {
      const [first, second] = [replayed[2 * i], replayed[2 * i + 1]];
      if (!first || !second || shown(first) !== shown(second))
        return stop({
          kind: 'nondeterministic',
          message: 'Two replays of the same answers did different things',
          answers,
        });
      if (first instanceof RemixReplayError)
        return stop({ kind: 'refused', message: first.message, answers });
      return first;
    });
  }

  async function walk(
    log: RemixLogEntry[],
    answers: RemixAnswer[],
    workflows: number,
    known?: RemixReplayOutcome | RemixGraphNode
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
    const outcome = known ?? (await outcomesOf(log, [{ answer: null, answers }]))[0];
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
    // Every option's next step at once: one sandbox call holds several branches.
    const nextOutcomes = await outcomesOf(
      log,
      options.map((answer) => ({ answer, answers: [...answers, answer] }))
    );
    for (const [i, answer] of options.entries()) {
      if (paths >= maxPaths) {
        if (!issues.some((issue) => issue.kind === 'too-many-paths'))
          issues.push({
            kind: 'too-many-paths',
            message: `More than ${maxPaths} paths; the rest were not checked`,
            answers,
          });
        break;
      }
      const next = await walk(
        [...log, { type: 'ask', answer }],
        [...answers, answer],
        workflows,
        nextOutcomes[i]
      );
      branches.push({ answer, next });
    }
    return { type: 'ask', spec: effect.spec, branches };
  }

  const graph = await walk([], [], 0);
  return { graph, paths, issues };
}
