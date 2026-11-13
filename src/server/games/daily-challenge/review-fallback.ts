import { logToAxiom } from '~/server/logging/client';

type FallbackContext = { challengeId: number; imageId: number; nsfwLevel: number };

/**
 * A failed review leaves the entry unjudged and retried every tick, so one provider outage stalls
 * every challenge; a second model on another provider keeps judging going.
 */
export async function reviewWithFallback<T>({
  run,
  fallbackModel,
  context,
}: {
  run: (model?: string) => Promise<T>;
  fallbackModel: string;
  context: FallbackContext;
}): Promise<T> {
  try {
    return await run(undefined);
  } catch (error) {
    logToAxiom({
      type: 'daily-challenge-review-fallback',
      ...context,
      fallbackModel,
      error: (error as Error).message,
    });
    return run(fallbackModel);
  }
}
