import type {
  RemixAnswer,
  RemixApp,
  RemixAppSource,
  RemixAsk,
  RemixImage,
  RemixWorkflowRequest,
  RemixWorkflowResult,
} from '~/shared/remix-apps/define';
import {
  REMIX_IMAGE_STAND_IN,
  remixLogSize,
  replayRemixApp,
  type RemixEffect,
  type RemixLogEntry,
  type RemixReplayer,
  type RemixReplayOutcome,
} from '~/shared/remix-apps/replay';

export type RemixTraceStep =
  | { type: 'workflow'; request: RemixWorkflowRequest; result: RemixWorkflowResult }
  | { type: 'ask'; spec: RemixAsk; answer: RemixAnswer };

/** The first option, the first image, a word: an answer every ask accepts. */
export function firstAnswer(spec: RemixAsk): RemixAnswer {
  if (spec.kind === 'choice') return spec.options[0].value;
  if (spec.kind === 'pick') return 0;
  if (spec.kind === 'image') return REMIX_IMAGE_STAND_IN;
  return 'remix';
}

export const MOCK_IMAGE_URL_PREFIX = 'mock://remix/';

/** Placeholder outputs shaped like the real ones: as many images, at the size they would be. */
export function mockResult(request: RemixWorkflowRequest, step: number): RemixWorkflowResult {
  const image = (i: number, width?: number, height?: number): RemixImage => ({
    url: `${MOCK_IMAGE_URL_PREFIX}${step}/${i}`,
    // A size the app chose can be any number.
    width: remixLogSize(width),
    height: remixLogSize(height),
  });
  if (request.kind === 'upscale') {
    const { width, height } = request.image;
    const scaled = (n?: number) => (n ? Math.round(n * request.scale) : undefined);
    return { workflowId: `mock-${step}`, images: [image(0, scaled(width), scaled(height))] };
  }
  const [first] = request.images;
  return {
    workflowId: `mock-${step}`,
    images: Array.from({ length: request.quantity }, (_, i) =>
      image(i, first?.width, first?.height)
    ),
  };
}

/**
 * Replays an app from `log`, answering each workflow with placeholders, until it asks something
 * or finishes. Returns the log with those workflows added, and each as a trace step.
 */
export async function playToAsk(
  app: RemixApp,
  source: RemixAppSource,
  from: readonly RemixLogEntry[],
  maxSteps = 16
): Promise<{
  log: RemixLogEntry[];
  steps: RemixTraceStep[];
  outcome:
    | Extract<RemixReplayOutcome, { status: 'done' }>
    | { status: 'effect'; index: number; effect: Extract<RemixEffect, { type: 'ask' }> };
}> {
  const log = [...from];
  const steps: RemixTraceStep[] = [];
  while (log.length < maxSteps) {
    const outcome = await replayRemixApp(app, source, log);
    if (outcome.status === 'done') return { log, steps, outcome };
    const { effect, index } = outcome;
    if (effect.type === 'ask') return { log, steps, outcome: { status: 'effect', index, effect } };
    const result = mockResult(effect.request, index);
    log.push({ type: 'workflow', result });
    steps.push({ type: 'workflow', request: effect.request, result });
  }
  throw new Error(`${app.slug} ran more than ${maxSteps} steps`);
}

/**
 * Runs an app end to end with no orchestrator: every workflow returns placeholder images, every
 * ask gets the answer `answer` picks. The same app, source and answers give the same trace, so an
 * app's shape can be checked without spending anything.
 */
export async function dryRunRemixApp(
  app: RemixApp,
  source: RemixAppSource,
  {
    answer = firstAnswer,
    maxSteps = 16,
  }: { answer?: (spec: RemixAsk, step: number) => RemixAnswer; maxSteps?: number } = {}
): Promise<{ trace: RemixTraceStep[]; outputs: RemixImage[] }> {
  let log: RemixLogEntry[] = [];
  const trace: RemixTraceStep[] = [];
  for (;;) {
    const played = await playToAsk(app, source, log, maxSteps);
    trace.push(...played.steps);
    const { outcome } = played;
    if (outcome.status === 'done') return { trace, outputs: outcome.outputs };
    const given = answer(outcome.effect.spec, outcome.index);
    log = [...played.log, { type: 'ask', answer: given }];
    trace.push({ type: 'ask', spec: outcome.effect.spec, answer: given });
  }
}

/**
 * What answering each option of the choice the run is waiting on leads to: the next effect, or
 * `null` when the app finishes on that answer. What a host prices the option buttons from.
 */
export async function remixOptionEffects(
  replay: RemixReplayer,
  source: RemixAppSource,
  log: readonly RemixLogEntry[],
  spec: Extract<RemixAsk, { kind: 'choice' }>
): Promise<{ value: string; next: RemixEffect | null }[]> {
  return Promise.all(
    spec.options.map(async ({ value }) => {
      const outcome = await replay(source, [...log, { type: 'ask', answer: value }]);
      return { value, next: outcome.status === 'done' ? null : outcome.effect };
    })
  );
}
