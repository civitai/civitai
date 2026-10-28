import { env } from '$env/dynamic/private';
import { NSFW_LEVEL_QUESTION, type ApplyOutcome, type ConsensusApplication } from './queue.service';

const trimSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);

const SKIP_REASONS = ['missing', 'blocked', 'locked'] as const;

/**
 * Writes a settled rating through the main app, so its caches and side effects run. The main app
 * decides whether the image may still take it: a refusal comes back as a `skipped` outcome and is
 * final, while a failed or unintelligible call throws and is retried.
 */
export async function applyConsensusToMainApp(
  application: ConsensusApplication
): Promise<ApplyOutcome> {
  if (application.questionKey !== NSFW_LEVEL_QUESTION) return { outcome: 'applied' };

  const token = env.WEBHOOK_TOKEN;
  if (!token) throw new Error('WEBHOOK_TOKEN is not configured');

  const base = trimSlash(env.CIVITAI_APP_URL || 'https://civitai.com');
  const res = await fetch(`${base}/api/mod/image/kono-set-nsfw-level`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-webhook-token': token },
    body: JSON.stringify({
      imageId: application.imageId,
      nsfwLevel: Number(application.value),
      userId: application.actorId,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`main app refused the rating (${res.status})`);

  const body: unknown = await res.json().catch(() => null);
  const answer = (body ?? {}) as { outcome?: unknown; reason?: unknown; currentLevel?: unknown };
  if (answer.outcome === 'applied') return { outcome: 'applied' };
  const reason = SKIP_REASONS.find((r) => r === answer.reason);
  if (answer.outcome === 'skipped' && reason) {
    return {
      outcome: 'skipped',
      reason,
      currentLevel: typeof answer.currentLevel === 'number' ? answer.currentLevel : null,
    };
  }
  throw new Error('main app answered with an outcome this app does not know');
}
