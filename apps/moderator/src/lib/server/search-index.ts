import { env } from '$env/dynamic/private';
import { civitaiAppUrl } from './civitai-url';

// HARD RULE: a spoke→main callback is allowed ONLY where main owns a fan-out the spoke cannot
// reproduce without becoming a second source of truth. Port everything else as a direct Kysely
// mutation. The full set, each with the capability that justifies it:
//
//   1. this Meilisearch enqueue          — main owns the search-index client
//   2. `kono.ts` finalize                — main owns the new-order game engine + WebSocket signals
//   3. `ban-user`                        — fans out to media purge, model unpublish, notifications, caches
//   4. `/api/mod/*` (comments,         — endpoint-side transactions the spoke would have to re-derive
//      reviews, buzz, purge)
//   5. remove/restore/flag images        — `handleBlockImages`/`handleUnblockImages` re-sync the search
//                                          index, recompute nsfwLevel and write ClickHouse tracking
//
// Adding to this list requires writing the capability next to it. An entry that cannot name one is a
// port that was skipped.
export async function syncSearchIndex(entity: {
  entityType: string;
  entityId: number;
  action?: 'update' | 'delete';
}): Promise<void> {
  const base = civitaiAppUrl();
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
