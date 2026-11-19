import * as z from 'zod';
import {
  REMIX_UPSCALE_SCALES,
  type RemixAnswer,
  type RemixApp,
  type RemixAppSource,
  type RemixAsk,
  type RemixCtx,
  type RemixImage,
  type RemixWorkflowRequest,
  type RemixWorkflowResult,
} from '~/shared/remix-apps/define';
import { REMIX_ASPECT_RATIOS } from '~/shared/remix-apps/row.schema';

export type RemixEffect =
  | { type: 'workflow'; request: RemixWorkflowRequest }
  | { type: 'ask'; spec: RemixAsk };

export type RemixLogEntry =
  | { type: 'workflow'; result: RemixWorkflowResult }
  | { type: 'ask'; answer: RemixAnswer };

export type RemixReplayOutcome =
  | { status: 'effect'; index: number; effect: RemixEffect }
  | { status: 'done'; outputs: RemixImage[] };

/** Replays an app over a run's log: in-process for a system app, the sandbox for a user app. */
export type RemixReplayer = (
  source: RemixAppSource,
  log: readonly RemixLogEntry[]
) => Promise<RemixReplayOutcome>;

export class RemixReplayError extends Error {}

/** What any app may ask of the host in one run, user apps included. */
export const REMIX_RUN_LIMITS = {
  effects: 16,
  textMaxLength: 500,
  choiceOptions: 12,
  pickImages: 4,
} as const;

// Not strict: an app may pass `ctx.source` itself, which also carries its imageId.
const image = z.object({
  url: z.string().min(1),
  width: z.number().optional(),
  height: z.number().optional(),
});

const effectSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('workflow'),
    request: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('image'),
        prompt: z.string(),
        images: z.array(image),
        aspectRatio: z.enum(['source', ...REMIX_ASPECT_RATIOS]),
        quantity: z.union([z.literal(1), z.literal(2), z.literal(4)]),
      }),
      z.strictObject({
        kind: z.literal('upscale'),
        image,
        scale: z.literal(REMIX_UPSCALE_SCALES),
      }),
    ]),
  }),
  z.strictObject({
    type: z.literal('ask'),
    spec: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('choice'),
        prompt: z.string(),
        options: z
          .array(z.strictObject({ value: z.string(), label: z.string() }))
          .min(1)
          .max(REMIX_RUN_LIMITS.choiceOptions),
        image: image.optional(),
      }),
      z.strictObject({
        kind: z.literal('pick'),
        prompt: z.string(),
        images: z.array(image).min(1).max(REMIX_RUN_LIMITS.pickImages),
      }),
      z.strictObject({
        kind: z.literal('text'),
        prompt: z.string(),
        maxLength: z.number().int().min(1).max(REMIX_RUN_LIMITS.textMaxLength),
        optional: z.boolean().optional(),
      }),
    ]),
  }),
]);

function imagesOf(effect: RemixEffect): RemixImage[] {
  if (effect.type === 'workflow')
    return effect.request.kind === 'image' ? effect.request.images : [effect.request.image];
  if (effect.spec.kind === 'pick') return effect.spec.images;
  return effect.spec.kind === 'choice' && effect.spec.image ? [effect.spec.image] : [];
}

class Suspend {
  constructor(readonly index: number, readonly effect: RemixEffect) {}
}

/**
 * The host's checks over one replay, effect by effect: each effect's shape and limits, that every
 * image it names is the source or an output of this run, and that it matches the log. Outside the
 * app, so a user app's runner result goes through the same checks.
 */
export function remixReplayChecks(
  slug: string,
  source: RemixAppSource,
  log: readonly RemixLogEntry[]
) {
  let next = 0;
  const made = new Set<string>();
  return {
    /** The recorded result for `effect`; throws `Suspend` at the first effect with none. */
    step(effect: RemixEffect) {
      const index = next++;
      if (index >= REMIX_RUN_LIMITS.effects)
        throw new RemixReplayError(`${slug} asked for more than ${REMIX_RUN_LIMITS.effects} steps`);
      if (!effectSchema.safeParse(effect).success)
        throw new RemixReplayError(
          `${slug} asked for a step the host does not run, at step ${index}`
        );
      if (imagesOf(effect).some(({ url }) => url !== source.url && !made.has(url)))
        throw new RemixReplayError(
          `${slug} named an image that is neither the source nor from this run, at step ${index}`
        );
      const entry = log[index];
      if (!entry) throw new Suspend(index, effect);
      if (entry.type !== effect.type)
        throw new RemixReplayError(
          `${slug} asked for a ${effect.type} at step ${index}, but the run recorded a ${entry.type}`
        );
      if (entry.type === 'workflow') {
        for (const { url } of entry.result.images) made.add(url);
        return entry.result;
      }
      // Recorded answers live in workflow metadata, which its owner can patch.
      const refusal = remixAnswerRefusal((effect as { spec: RemixAsk }).spec, entry.answer);
      if (refusal) throw new RemixReplayError(`step ${index} has an answer that does not fit`);
      return entry.answer;
    },
    finish(outputs: RemixImage[]) {
      if (next < log.length)
        throw new RemixReplayError(
          `${slug} finished after ${next} steps, but the run recorded ${log.length}`
        );
      if (!z.array(image).safeParse(outputs).success || outputs.some(({ url }) => !made.has(url)))
        throw new RemixReplayError(`${slug} returned an image this run did not make`);
      return outputs;
    },
  };
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
  const checks = remixReplayChecks(app.slug, source, log);
  // The first stop is final: an app that catches it and goes on still stops there.
  let stop: Suspend | RemixReplayError | undefined;
  const step = (effect: RemixEffect) => {
    if (stop) throw stop;
    try {
      return checks.step(effect);
    } catch (error) {
      if (error instanceof Suspend || error instanceof RemixReplayError) stop = error;
      throw error;
    }
  };

  const ctx: RemixCtx = {
    source: Object.freeze({ ...source }),
    workflow: async (request) => step({ type: 'workflow', request }) as RemixWorkflowResult,
    ask: async (spec) => step({ type: 'ask', spec }) as never,
  };

  let outputs: RemixImage[] | undefined;
  try {
    outputs = await app.run(ctx);
  } catch (error) {
    if (!stop) throw error;
  }
  if (stop instanceof Suspend) return { status: 'effect', index: stop.index, effect: stop.effect };
  if (stop) throw stop;
  return { status: 'done', outputs: checks.finish(outputs as RemixImage[]) };
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
