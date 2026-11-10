import { env } from '~/env/server';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';

export const SEARCH_UPDATE_EVENT = 'search.update';

/** The entities whose index updates the semantic search sync hears about through "Outbox". */
export type SearchOutboxEntity = 'Article' | 'Comic';

/**
 * Why an index update was queued. Metrics churn every article on each run without changing what
 * search embeds, so a 'metrics' update is never forwarded.
 */
export type SearchUpdateReason = string;

/**
 * Writes one "Outbox" row per id for the semantic search sync, which re-reads eligibility itself.
 * Runs on its own connection, never a caller's transaction: a failed statement aborts the
 * transaction it runs in even when caught. A failure is logged, never thrown, so no save can fail
 * because of it.
 */
export async function forwardSearchUpdate({
  entityType,
  items,
  reason,
}: {
  entityType: SearchOutboxEntity;
  items: { id: number; action?: SearchIndexUpdateQueueAction }[];
  reason?: SearchUpdateReason;
}) {
  if (reason === 'metrics' || !items.length) return;
  if (!env.SEARCH_OUTBOX_FORWARD.includes(entityType)) return;

  try {
    await dbWrite.outbox.createMany({
      data: items.map(({ id, action = SearchIndexUpdateQueueAction.Update }) => ({
        event: SEARCH_UPDATE_EVENT,
        entityType,
        entityId: id,
        details: { reason: reason ?? null, action },
      })),
    });
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'search-outbox-forward',
      message: (error as Error).message,
      details: { entityType, reason, count: items.length },
    }).catch(() => undefined);
  }
}
