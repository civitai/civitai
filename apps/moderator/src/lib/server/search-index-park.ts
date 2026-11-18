import { sql } from '@civitai/db/kysely';
import {
  MODELS_SEARCH_INDEX,
  SEARCH_INDEX_QUEUE_FALLBACK_MAX_IDS,
  searchIndexQueueFallbackKey,
} from '@civitai/shared/search-index-queue';
import { logAxiomError } from './axiom';
import { dbWrite } from './db';

/**
 * For a models-index requeue the main app did not take: parks the ids in the main app's search-index
 * parking lot, which its `search-index-queue-drain` job replays onto the queue. Never throws: it
 * follows a committed write.
 */
export async function parkModelSearchUpdates(modelIds: number[]): Promise<void> {
  const ids = [...new Set(modelIds)];
  if (!ids.length) return;
  const key = searchIndexQueueFallbackKey(MODELS_SEARCH_INDEX, 'Update');
  try {
    // The main app's `persistDroppedEnqueue` writes the same row the same way.
    const { rows } = await sql<{ capped: boolean }>`
      INSERT INTO "KeyValue" ("key", "value")
      VALUES (${key}, ${JSON.stringify(ids)}::jsonb)
      ON CONFLICT ("key") DO UPDATE SET "value" =
        CASE
          WHEN jsonb_array_length("KeyValue"."value") >= ${SEARCH_INDEX_QUEUE_FALLBACK_MAX_IDS}
            THEN "KeyValue"."value"
          ELSE "KeyValue"."value" || EXCLUDED."value"
        END
      RETURNING (jsonb_array_length("value") >= ${SEARCH_INDEX_QUEUE_FALLBACK_MAX_IDS}) AS capped
    `.execute(dbWrite);
    if (rows[0]?.capped)
      void logAxiomError(new Error(`parking lot for ${key} is at its id cap`), {
        name: 'search-index-park',
        modelIds: ids,
      });
  } catch (error) {
    void logAxiomError(error, { name: 'search-index-park', modelIds: ids });
  }
}
