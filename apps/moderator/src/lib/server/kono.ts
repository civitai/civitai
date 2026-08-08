import { env } from '$env/dynamic/private';

export async function syncKonoFinalize(imageId: number, nsfwLevel: number): Promise<void> {
  const base = env.CIVITAI_APP_URL || 'https://civitai.com';
  const token = env.WEBHOOK_TOKEN;
  if (!token) {
    console.warn('[kono] WEBHOOK_TOKEN not set — skipping KoNO finalize', { imageId });
    return;
  }

  try {
    const res = await fetch(`${base}/api/internal/kono-finalize?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageId, nsfwLevel }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error('[kono] finalize failed', res.status, await res.text());
  } catch (err) {
    console.error('[kono] finalize error', err);
  }
}
