import { env } from '$env/dynamic/private';

// HARD RULE: spoke→main callbacks are a closed set of THREE, each for a capability the spoke
// fundamentally lacks — (1) this Meilisearch enqueue (main owns the search-index client), (2) the KoNO
// finalize in `kono.ts` (main owns the new-order game engine + WebSocket signals), and (3) `ban-user` in
// `user-actions.service.ts` (one ban fans out to media purge, model unpublish, notifications and cache
// busting across systems the spoke does not own; reimplementing it would be a second source of truth for
// what banning means).
//
// Do NOT add a fourth: port the logic here as a direct Kysely mutation instead. If you believe you have a
// genuine exception, it belongs in this list with its reason — not added silently, which is how the set
// went from two to three.
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
