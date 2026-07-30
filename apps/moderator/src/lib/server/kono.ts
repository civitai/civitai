import { env } from '$env/dynamic/private';

// Delegate the Knights-of-New-Order finalization to the main app after the spoke sets an image's nsfwLevel.
// The KoNO game engine (ClickHouse vote finalize + smites + player counters + review-pool reset) and its
// real-time WebSocket player-stat signals live in the main app; the spoke has ClickHouse/Redis but no signals
// client, and reimplementing the engine would drift from main. So this is the SECOND (and only other)
// sanctioned spoke→main callback besides the Meilisearch enqueue — see search-index.ts. Fire-and-forget: call
// WITHOUT await so a slow/down main app can't stall the moderator action; it self-bounds with a timeout and
// never throws. No-ops when WEBHOOK_TOKEN is unset (as in local dev without a main app).
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
