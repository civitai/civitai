import { env } from '$env/dynamic/private';

// HARD RULE: spoke→main callbacks are a closed set of TWO, each for a capability the spoke fundamentally
// lacks — (1) this Meilisearch enqueue (main owns the search-index client), and (2) the KoNO finalize in
// `kono.ts` (main owns the new-order game engine + WebSocket signals). Do NOT add a third: port the logic
// here as a direct Kysely mutation instead.
export async function syncSearchIndex(entity: {
  entityType: string;
  entityId: number;
  action?: 'update' | 'delete';
}): Promise<void> {
  const base = env.CIVITAI_APP_URL || 'https://civitai.com';
  const token = env.WEBHOOK_TOKEN;
  if (!token) {
    console.warn('[search-index] WEBHOOK_TOKEN not set — skipping Meilisearch sync', entity);
    return;
  }

  try {
    const res = await fetch(`${base}/api/internal/search-index-update?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entity),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error('[search-index] sync failed', res.status, await res.text());
  } catch (err) {
    console.error('[search-index] sync error', err);
  }
}
