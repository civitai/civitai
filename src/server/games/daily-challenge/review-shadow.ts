import { logToAxiom } from '~/server/logging/client';

export type ReviewShadowConfig = { model: string; sampleRate: number };

type ShadowableReview = {
  model: string;
  score: unknown;
  reaction: string;
  comment: string;
  summary: string;
};

type ShadowContext = { challengeId: number; imageId: number; nsfwLevel: number };

async function timed<T>(fn: () => Promise<T>) {
  const start = Date.now();
  try {
    return { ok: true as const, value: await fn(), ms: Date.now() - start };
  } catch (error) {
    return { ok: false as const, error: (error as Error).message, ms: Date.now() - start };
  }
}

function describeOutcome(
  outcome: Awaited<ReturnType<typeof timed<ShadowableReview>>>,
  model: string | undefined
) {
  if (!outcome.ok) return { ok: false, model, ms: outcome.ms, error: outcome.error };
  const { model: reviewModel, score, reaction, comment, summary } = outcome.value;
  return { ok: true, model: reviewModel, ms: outcome.ms, score, reaction, comment, summary };
}

/**
 * Runs the production review and, for a sampled share of entries, the same review on a candidate
 * model, logging both to Axiom. Only the production review is returned; the shadow is never
 * awaited, so a slow or failing candidate cannot delay or break judging.
 */
export async function reviewWithShadow<T extends ShadowableReview>({
  run,
  shadow,
  context,
}: {
  run: (model?: string) => Promise<T>;
  shadow: ReviewShadowConfig | null | undefined;
  context: ShadowContext;
}): Promise<T> {
  const primary = run(undefined);
  if (!shadow || Math.random() >= shadow.sampleRate) return primary;

  void Promise.all([timed(() => primary), timed(() => run(shadow.model))]).then(
    ([primaryOutcome, shadowOutcome]) =>
      logToAxiom({
        type: 'daily-challenge-review-shadow',
        ...context,
        primary: describeOutcome(primaryOutcome, undefined),
        shadow: describeOutcome(shadowOutcome, shadow.model),
      })
  );
  return primary;
}
