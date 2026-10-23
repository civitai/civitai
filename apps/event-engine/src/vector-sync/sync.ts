import type { Pool } from 'pg';
import { buildEmbedInput, type Embedder, type EmbedInput } from './embedder';
import { isEligible, type ImageRow } from './eligibility';
import type { VectorStore } from './qdrant';
import { getImageRows, getPayloads } from './source';

export type VectorStoreLike = Pick<
  VectorStore,
  'existing' | 'delete' | 'setPayloads' | 'upsert' | 'assertModel'
>;

export type SyncDeps = {
  pg: Pick<Pool, 'query'>;
  store: VectorStoreLike;
  /** Null when embedding is switched off: eligible images with no point are counted, not embedded. */
  embedder: Pick<Embedder, 'embed'> | null;
  dryRun?: boolean;
};

export type SyncStats = {
  eligible: number;
  embedded: number;
  updated: number;
  deleted: number;
  failed: number;
  embedOff: number;
  skipped: Record<string, number>;
};

export function emptyStats(): SyncStats {
  return { eligible: 0, embedded: 0, updated: 0, deleted: 0, failed: 0, embedOff: 0, skipped: {} };
}

export function addStats(into: SyncStats, from: SyncStats) {
  for (const key of ['eligible', 'embedded', 'updated', 'deleted', 'failed', 'embedOff'] as const)
    into[key] += from[key];
  for (const [reason, n] of Object.entries(from.skipped))
    into.skipped[reason] = (into.skipped[reason] ?? 0) + n;
}

/** Re-reads the images and makes Qdrant match their current state. */
export async function syncImageIds(ids: number[], deps: SyncDeps): Promise<SyncStats> {
  const unique = [...new Set(ids)];
  const rows = await getImageRows(deps.pg as Pool, unique);
  const found = new Set(rows.map((r) => r.id));
  return syncRows(
    rows,
    unique.filter((id) => !found.has(id)),
    deps
  );
}

/**
 * Eligible with a point: payload overwritten. Eligible without one: embedded. Everything else,
 * including ids with no row (`goneIds`): point deleted. Idempotent, so a redelivered event or a
 * resumed backfill page only repeats work it can afford.
 */
export async function syncRows(
  rows: ImageRow[],
  goneIds: number[],
  deps: SyncDeps
): Promise<SyncStats> {
  const stats = emptyStats();
  const eligible = rows.filter(isEligible);
  const remove = [...goneIds, ...rows.filter((r) => !isEligible(r)).map((r) => r.id)];
  stats.eligible = eligible.length;

  // Every new upload passes through here unscanned; only ids with a point cost a delete.
  const [existing, toDelete] = await Promise.all([
    deps.store.existing(eligible.map((r) => r.id)),
    deps.store.existing(remove),
  ]);
  const payloads = await getPayloads(deps.pg as Pool, eligible);
  const update = new Map([...payloads].filter(([id]) => existing.has(id)));

  const inputs: EmbedInput[] = [];
  for (const row of eligible) {
    if (existing.has(row.id)) continue;
    const built = buildEmbedInput(row);
    if ('skip' in built) stats.skipped[built.skip] = (stats.skipped[built.skip] ?? 0) + 1;
    else inputs.push(built.input);
  }

  stats.deleted = toDelete.size;
  stats.updated = update.size;
  if (deps.dryRun) {
    // Counts what a real run would embed.
    stats.embedded = inputs.length;
    return stats;
  }

  await deps.store.delete([...toDelete]);
  await deps.store.setPayloads(update);
  if (!deps.embedder) {
    stats.embedOff = inputs.length;
    return stats;
  }
  if (!inputs.length) return stats;

  const result = await deps.embedder.embed(inputs);
  if (result.stamp) await deps.store.assertModel(result.stamp);
  const points = [...result.vectors]
    .filter(([id]) => payloads.has(id))
    .map(([id, vector]) => ({ id, vector, payload: payloads.get(id)! }));
  await deps.store.upsert(points);
  stats.embedded = points.length;
  stats.failed = result.failed.length;

  // The rows were read before a slow embed. An image blocked meanwhile may already have had its
  // delete applied by another worker, which this upsert would undo; re-reading after the write
  // closes that window, and any change committed later arrives as its own event.
  const embeddedIds = points.map((p) => p.id);
  const now = await getImageRows(deps.pg as Pool, embeddedIds);
  const stillEligible = new Set(now.filter(isEligible).map((r) => r.id));
  const lapsed = embeddedIds.filter((id) => !stillEligible.has(id));
  await deps.store.delete(lapsed);
  stats.embedded -= lapsed.length;
  stats.deleted += lapsed.length;
  return stats;
}
