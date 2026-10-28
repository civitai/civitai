import { env } from '$env/dynamic/private';
import { NSFW_LEVEL_QUESTION, type ConsensusApplication } from './queue.service';

const trimSlash = (value: string) => (value.endsWith('/') ? value.slice(0, -1) : value);

/** Writes a settled rating through the main app, so its caches and side effects run. */
export async function applyConsensusToMainApp(application: ConsensusApplication): Promise<void> {
  if (application.questionKey !== NSFW_LEVEL_QUESTION) return;

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
}
