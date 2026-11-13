import type {
  RemixAnswer,
  RemixApp,
  RemixAppSource,
  RemixAsk,
  RemixImage,
  RemixWorkflowRequest,
  RemixWorkflowResult,
} from '~/shared/remix-apps/define';
import { replayRemixApp, type RemixEffect, type RemixLogEntry } from '~/shared/remix-apps/replay';

export type RemixTraceStep =
  | { type: 'workflow'; request: RemixWorkflowRequest; result: RemixWorkflowResult }
  | { type: 'ask'; spec: RemixAsk; answer: RemixAnswer };

/** The first option, the first image, a word: an answer every ask accepts. */
export function firstAnswer(spec: RemixAsk): RemixAnswer {
  if (spec.kind === 'choice') return spec.options[0].value;
  if (spec.kind === 'pick') return 0;
  return 'remix';
}

/** Placeholder outputs shaped like the real ones: as many images, at the size they would be. */
function mockResult(request: RemixWorkflowRequest, step: number): RemixWorkflowResult {
  const image = (i: number, width?: number, height?: number): RemixImage => ({
    url: `mock://remix/${step}/${i}`,
    width,
    height,
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
  const log: RemixLogEntry[] = [];
  const trace: RemixTraceStep[] = [];
  while (trace.length < maxSteps) {
    const outcome = await replayRemixApp(app, source, log);
    if (outcome.status === 'done') return { trace, outputs: outcome.outputs };
    const { effect, index } = outcome;
    if (effect.type === 'workflow') {
      const result = mockResult(effect.request, index);
      log.push({ type: 'workflow', result });
      trace.push({ type: 'workflow', request: effect.request, result });
    } else {
      const given = answer(effect.spec, index);
      log.push({ type: 'ask', answer: given });
      trace.push({ type: 'ask', spec: effect.spec, answer: given });
    }
  }
  throw new Error(`${app.slug} ran more than ${maxSteps} steps`);
}

/**
 * What answering each option of the choice the run is waiting on leads to: the next effect, or
 * `null` when the app finishes on that answer. What a host prices the option buttons from.
 */
export async function remixOptionEffects(
  app: RemixApp,
  source: RemixAppSource,
  log: readonly RemixLogEntry[],
  spec: Extract<RemixAsk, { kind: 'choice' }>
): Promise<{ value: string; next: RemixEffect | null }[]> {
  return Promise.all(
    spec.options.map(async ({ value }) => {
      const outcome = await replayRemixApp(app, source, [...log, { type: 'ask', answer: value }]);
      return { value, next: outcome.status === 'done' ? null : outcome.effect };
    })
  );
}
