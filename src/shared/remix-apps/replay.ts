import type {
  RemixAnswer,
  RemixApp,
  RemixAppSource,
  RemixAsk,
  RemixCtx,
  RemixImage,
  RemixWorkflowRequest,
  RemixWorkflowResult,
} from '~/shared/remix-apps/define';

export type RemixEffect =
  | { type: 'workflow'; request: RemixWorkflowRequest }
  | { type: 'ask'; spec: RemixAsk };

export type RemixLogEntry =
  | { type: 'workflow'; result: RemixWorkflowResult }
  | { type: 'ask'; answer: RemixAnswer };

export type RemixReplayOutcome =
  | { status: 'effect'; index: number; effect: RemixEffect }
  | { status: 'done'; outputs: RemixImage[] };

export class RemixReplayError extends Error {}

class Suspend {
  constructor(readonly index: number, readonly effect: RemixEffect) {}
}

/**
 * Re-runs the app from the start against the recorded results, and returns the first effect with
 * no result yet, or the outputs once `run` returns. Pure: the same app, source and log always give
 * the same outcome.
 */
export async function replayRemixApp(
  app: RemixApp,
  source: RemixAppSource,
  log: readonly RemixLogEntry[]
): Promise<RemixReplayOutcome> {
  let next = 0;
  const step = (effect: RemixEffect) => {
    const index = next++;
    const entry = log[index];
    if (!entry) throw new Suspend(index, effect);
    if (entry.type !== effect.type)
      throw new RemixReplayError(
        `${app.slug} asked for a ${effect.type} at step ${index}, but the run recorded a ${entry.type}`
      );
    if (entry.type === 'workflow') return entry.result;
    // Recorded answers live in workflow metadata, which its owner can patch.
    const refusal = remixAnswerRefusal((effect as { spec: RemixAsk }).spec, entry.answer);
    if (refusal) throw new RemixReplayError(`step ${index} has an answer that does not fit`);
    return entry.answer;
  };

  const ctx: RemixCtx = {
    source: Object.freeze({ ...source }),
    workflow: async (request) => step({ type: 'workflow', request }) as RemixWorkflowResult,
    ask: async (spec) => step({ type: 'ask', spec }) as never,
  };

  try {
    const outputs = await app.run(ctx);
    if (next < log.length)
      throw new RemixReplayError(
        `${app.slug} finished after ${next} steps, but the run recorded ${log.length}`
      );
    return { status: 'done', outputs };
  } catch (error) {
    if (error instanceof Suspend)
      return { status: 'effect', index: error.index, effect: error.effect };
    throw error;
  }
}

/** Why an answer does not fit its ask, or `undefined` when it does. */
export function remixAnswerRefusal(spec: RemixAsk, answer: RemixAnswer): string | undefined {
  switch (spec.kind) {
    case 'choice':
      return spec.options.some((o) => o.value === answer) ? undefined : 'Not one of the options';
    case 'pick':
      return Number.isInteger(answer) && +answer >= 0 && +answer < spec.images.length
        ? undefined
        : 'Not one of the images';
    case 'text':
      if (typeof answer !== 'string' || answer.length > spec.maxLength)
        return `Enter up to ${spec.maxLength} characters`;
      if (answer.trim()) return undefined;
      // A skip is '' exactly, so the app never sees blank text it has to trim.
      return spec.optional && answer === ''
        ? undefined
        : `Enter up to ${spec.maxLength} characters`;
  }
}
