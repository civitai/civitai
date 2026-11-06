import type { Pool } from 'pg';
import type { Embedder, EmbedInput } from '../embedder';
import type { VectorStore } from '../qdrant';
import { getModelDocs, type ModelPayload } from './source';

export type ModelStore = Pick<
  VectorStore<ModelPayload>,
  'payloadFields' | 'delete' | 'setPayloads' | 'upsert' | 'assertModel'
>;

export type ModelSyncDeps = {
  pg: Pick<Pool, 'query'>;
  store: ModelStore;
  /** Null: models needing a vector are counted, not embedded. */
  embedder: Pick<Embedder, 'embed'> | null;
  dryRun?: boolean;
};

export type ModelSyncStats = {
  eligible: number;
  embedded: number;
  updated: number;
  deleted: number;
  failed: number;
  /** Models that needed a vector while embedding was off. */
  embedOff: number;
  /** Still edited after the last round; the next sync of the id re-embeds them. */
  stale: number;
};

export const emptyModelStats = (): ModelSyncStats => ({
  eligible: 0,
  embedded: 0,
  updated: 0,
  deleted: 0,
  failed: 0,
  embedOff: 0,
  stale: 0,
});

/** A model edited while its vector was being made is synced again, at most this many times. */
const MAX_ROUNDS = 3;

/**
 * Makes Qdrant match the models' current state. No point and eligible: embedded. A point whose
 * document changed: re-embedded. Unchanged document: payload overwritten. Ineligible or gone:
 * point deleted. Idempotent, so a redelivered event or a re-run page only repeats work.
 */
export async function syncModelIds(ids: number[], deps: ModelSyncDeps): Promise<ModelSyncStats> {
  const stats = emptyModelStats();
  let pending = [...new Set(ids)];
  for (let round = 0; pending.length && round < MAX_ROUNDS; round++) {
    pending = await syncRound(pending, deps, stats, round === 0);
  }
  stats.stale = pending.length;
  return stats;
}

/** One pass; returns the ids whose document changed during the embed. */
async function syncRound(
  ids: number[],
  deps: ModelSyncDeps,
  stats: ModelSyncStats,
  first: boolean
): Promise<number[]> {
  const [docs, points] = await Promise.all([
    getModelDocs(deps.pg, ids),
    deps.store.payloadFields(ids, ['docHash']),
  ]);
  if (first) stats.eligible += docs.size;

  const remove = ids.filter((id) => points.has(id) && !docs.has(id));
  const update = new Map<number, ModelPayload>();
  const inputs: EmbedInput[] = [];
  for (const [id, payload] of docs) {
    const stored = points.get(id);
    if (stored?.docHash === payload.docHash) {
      update.set(id, payload);
      continue;
    }
    inputs.push({ id: String(id), text: payload.search_text });
    // Until the re-embed lands, the old vector serves with the current payload: a stale nsfwLevel
    // would let filters match what they must not. The old hash stays, so a failed re-embed is
    // retried by the next sync.
    if (stored) update.set(id, { ...payload, docHash: stored.docHash! });
  }
  stats.deleted += remove.length;
  stats.updated += update.size;
  if (deps.dryRun) {
    stats.embedded += inputs.length;
    return [];
  }
  await deps.store.delete(remove);
  await deps.store.setPayloads(update);
  if (!inputs.length) return [];
  if (!deps.embedder) {
    stats.embedOff += inputs.length;
    return [];
  }

  const written = new Set<number>();
  const store = async (vectors: Map<number, number[]>) => {
    const fresh = [...vectors].filter(([id]) => !written.has(id));
    if (!fresh.length) return;
    await deps.store.upsert(fresh.map(([id, vector]) => ({ id, vector, payload: docs.get(id)! })));
    for (const [id] of fresh) written.add(id);
    stats.embedded += fresh.length;
  };
  const result = await deps.embedder.embed(inputs, {
    acceptStamp: (stamp) => deps.store.assertModel(stamp),
    onVectors: store,
  });
  await store(result.vectors);
  stats.failed += result.failed.length;

  // The documents were read before a slow embed. An unpublish, delete or edit committed meanwhile
  // may already have been synced by another worker, which these upserts would undo; re-reading
  // now catches it. Anything committed later arrives as its own event, and by then the point exists.
  const now = await getModelDocs(deps.pg, [...written]);
  const lapsed = [...written].filter((id) => !now.has(id));
  const changed: number[] = [];
  const repayload = new Map<number, ModelPayload>();
  for (const [id, payload] of now) {
    if (payload.docHash !== docs.get(id)!.docHash) changed.push(id);
    else if (JSON.stringify(payload) !== JSON.stringify(docs.get(id))) repayload.set(id, payload);
  }
  await deps.store.delete(lapsed);
  await deps.store.setPayloads(repayload);
  stats.embedded -= lapsed.length;
  stats.deleted += lapsed.length;
  stats.updated += repayload.size;

  if (result.error) throw result.error;
  return changed;
}
