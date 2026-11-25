import type { ChallengeConfig } from '~/server/games/daily-challenge/daily-challenge.utils';
import { logToAxiom } from '~/server/logging/client';
import { getIsSafeBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { ChallengeSource } from '~/shared/utils/prisma/enums';

export type ReviewShadowConfig = NonNullable<ChallengeConfig['reviewShadow']>;

type ShadowableReview = {
  model: string;
  score: unknown;
  reaction: string;
  comment: string;
  summary: string;
  /** OpenRouter's id for the call; its generation API names the host that served it. */
  generationId?: string;
};

/**
 * Whether an entry may go to the shadow model, a third party outside production judging: only
 * a System daily that is SFW, and only an image the scan has cleared at an SFW level.
 */
export function shadowSendable({
  source,
  allowedNsfwLevel,
  entry,
}: {
  source: ChallengeSource | undefined;
  allowedNsfwLevel: number;
  entry: { nsfwLevel: number; ingestion?: string; blockedFor?: string | null };
}) {
  return (
    source === ChallengeSource.System &&
    getIsSafeBrowsingLevel(allowedNsfwLevel) &&
    entry.ingestion === 'Scanned' &&
    !entry.blockedFor &&
    getIsSafeBrowsingLevel(entry.nsfwLevel)
  );
}

/**
 * The shadow config to run for this entry, or null. A config with no provider pin that denies
 * data collection never sends: without one the call goes to any host on the account's defaults.
 */
export function shadowFor(
  shadow: ReviewShadowConfig | null | undefined,
  input: Parameters<typeof shadowSendable>[0]
) {
  if (!shadow || shadow.provider?.dataCollection !== 'deny') return null;
  return shadowSendable(input) ? shadow : null;
}

/** Stands in for the entrant's username in the shadow call: a score comparison does not need it. */
export function shadowCreatorLabel(imageId: number) {
  return `entry ${imageId}`;
}

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
  const { model: reviewModel, score, reaction, comment, summary, generationId } = outcome.value;
  return {
    ok: true,
    model: reviewModel,
    ms: outcome.ms,
    score,
    reaction,
    comment,
    summary,
    generationId,
  };
}

/**
 * Only the production review is returned; the shadow is never awaited, so a slow or failing
 * candidate cannot delay or break judging.
 */
export async function reviewWithShadow<T extends ShadowableReview>({
  run,
  shadow,
  context,
}: {
  run: (model?: string, provider?: ReviewShadowConfig['provider']) => Promise<T>;
  shadow: ReviewShadowConfig | null | undefined;
  context: ShadowContext;
}): Promise<T> {
  const primary = run(undefined);
  if (!shadow || Math.random() >= shadow.sampleRate) return primary;

  void Promise.all([timed(() => primary), timed(() => run(shadow.model, shadow.provider))])
    .then(([primaryOutcome, shadowOutcome]) =>
      logToAxiom({
        type: 'daily-challenge-review-shadow',
        ...context,
        primary: describeOutcome(primaryOutcome, undefined),
        shadow: describeOutcome(shadowOutcome, shadow.model),
      })
    )
    .catch((error) => console.error('[review-shadow] failed to log', error));
  return primary;
}
