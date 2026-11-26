import { env } from '$env/dynamic/private';
import { tryCivitaiInternalUrl } from './civitai-url';
import { mainAppHostFetch } from './main-app-fetch';

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
//   6. `/api/v1/model-versions/bust-cache` — `bustMvCache` spans six caches, a CDN purge and the search
//                                          queue; `resourceDataCache` holds `Model.nsfw` for an hour
//   7. `home-block-evict` (home-blocks.ts) — main owns the home-block cache: its keys, the lookup of
//                                          the collections showing an image, and the second refresh
//                                          once replicas catch up
//
// Adding to this list requires writing the capability next to it. An entry that cannot name one is a
// port that was skipped.
export async function syncSearchIndex(entity: {
  entityType: string;
  entityId: number;
  action?: 'update' | 'delete';
}): Promise<void> {
  await postSync(entity, entity);
}

const MAX_IDS_PER_REQUEST = 1000;

/** Chunked to the `.max(1000)` on `src/pages/api/internal/search-index-update.ts` — lower that without
 *  lowering this and every oversized batch 400s here, silently. Empty in, nothing sent. `strict` throws
 *  on a failed or refused call instead of only logging it, so a caller can retry. */
export async function syncSearchIndexBulk(
  batch: {
    entityType: string;
    entityIds: number[];
    action?: 'update' | 'delete';
  },
  { strict = false }: { strict?: boolean } = {}
): Promise<void> {
  const ids = [...new Set(batch.entityIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return;

  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    const entityIds = ids.slice(i, i + MAX_IDS_PER_REQUEST);
    await postSync(
      { entityType: batch.entityType, entityIds, action: batch.action },
      { entityType: batch.entityType, count: entityIds.length },
      strict
    );
  }
}

/** `logContext` is what reaches the console on failure — never the id array, which can be 1,000 long. */
async function postSync(body: unknown, logContext: unknown, strict = false): Promise<void> {
  const token = env.WEBHOOK_TOKEN;
  if (!token) {
    console.warn('[search-index] WEBHOOK_TOKEN not set — skipping Meilisearch sync', logContext);
    if (strict) throw new Error('search-index sync skipped: WEBHOOK_TOKEN not set');
    return;
  }
  const base = tryCivitaiInternalUrl();
  if (base === null) {
    if (strict) throw new Error('search-index sync skipped: CIVITAI_INTERNAL_URL not set');
    return;
  }

  try {
    const res = await mainAppHostFetch(`${base}/api/internal/search-index-update?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('[search-index] sync failed', res.status, text);
      if (strict) throw new Error(`search-index sync failed: ${res.status}`);
    }
  } catch (err) {
    // Neither `err` nor its message, logged or rethrown: a URL parse error carries the request URL,
    // token included.
    const { name = 'unknown', cause } = (err ?? {}) as { name?: string; cause?: { code?: string } };
    console.error('[search-index] sync error', name, cause?.code ?? '', logContext);
    if (strict) throw new Error(`search-index sync error: ${name}`);
  }
}
