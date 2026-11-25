import { env } from '$env/dynamic/private';
import { tryCivitaiInternalUrl } from './civitai-url';

/**
 * Refreshes the main app's home blocks showing these images. Call it after the write that hides
 * them has committed. Never throws: the hide stands either way.
 */
export async function evictHomeBlocks(imageIds: number[]): Promise<void> {
  const ids = [...new Set(imageIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return;
  const token = env.WEBHOOK_TOKEN;
  if (!token) {
    console.warn('[home-blocks] WEBHOOK_TOKEN not set; skipping the home-block refresh');
    return;
  }
  const base = tryCivitaiInternalUrl();
  if (base === null) return;
  try {
    const res = await fetch(`${base}/api/internal/home-block-evict?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageIds: ids }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error('[home-blocks] refresh failed', res.status, { count: ids.length });
  } catch (err) {
    // Neither `err` nor its message: a URL parse error carries the request URL, token included.
    const { name = 'unknown', cause } = (err ?? {}) as { name?: string; cause?: { code?: string } };
    console.error('[home-blocks] refresh error', name, cause?.code ?? '', { count: ids.length });
  }
}
