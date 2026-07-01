import { env } from '$env/dynamic/private';

// Trigger a Meilisearch re-index in the main app for an entity we just mutated in Postgres. The main
// app owns the search-index client + per-entity logic (src/pages/api/internal/search-index-update.ts);
// this spoke just pings its callback. Fire-and-forget — call it WITHOUT `await` so a slow/down main app
// can't stall the moderator action; it self-bounds with a timeout and never throws.
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
