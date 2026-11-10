import { createHash } from 'crypto';
import type { Pool } from 'pg';
import type { Embedder, EmbedInput } from '../embedder';
import type { VectorStore } from '../qdrant';

/** What every text-search point carries; a domain adds its own filter and display fields. */
export type DomainPayload = Record<string, unknown> & {
  /** The embedded document, for phrase filters. */
  search_text: string;
  /** sha256 of search_text: a point whose hash differs is re-embedded. */
  docHash: string;
  /** Hash of the rest of the payload as last written, so an unchanged re-read writes nothing. */
  payloadHash?: string;
};

/** The current payloads of the eligible rows among `ids`; an id missing from the map gets no point. */
export type GetDocs<P> = (pg: Pick<Pool, 'query'>, ids: number[]) => Promise<Map<number, P>>;

export type DomainStore<P extends DomainPayload> = Pick<
  VectorStore<P>,
  'payloadFields' | 'delete' | 'setPayloads' | 'upsert' | 'assertModel'
>;

export type DomainSyncDeps<P extends DomainPayload> = {
  pg: Pick<Pool, 'query'>;
  store: DomainStore<P>;
  /** Null: rows needing a vector are counted, not embedded. */
  embedder: Pick<Embedder, 'embed'> | null;
  dryRun?: boolean;
};

export type SyncStats = {
  eligible: number;
  embedded: number;
  updated: number;
  /** Points whose payload and vector already matched: nothing written. */
  unchanged: number;
  deleted: number;
  failed: number;
  /** Rows that needed a vector while embedding was off. */
  embedOff: number;
  /** Still edited after the last round; the next sync of the id re-embeds them. */
  stale: number;
};

export const emptyStats = (): SyncStats => ({
  eligible: 0,
  embedded: 0,
  updated: 0,
  unchanged: 0,
  deleted: 0,
  failed: 0,
  embedOff: 0,
  stale: 0,
});

/** A row edited while its vector was being made is synced again, at most this many times. */
const MAX_ROUNDS = 3;

const stable = (value: unknown): string =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? `{${Object.keys(value)
        // Qdrant drops an undefined key, so it hashes as absent; null is stored and stays distinct.
        .filter((k) => k !== 'payloadHash' && (value as Record<string, unknown>)[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
        .join(',')}}`
    : Array.isArray(value)
    ? `[${value.map(stable).join(',')}]`
    : JSON.stringify(value) ?? 'null';

/** The payload as written: with the hash of everything in it, docHash included. */
export function withPayloadHash<P extends DomainPayload>(payload: P): P {
  return { ...payload, payloadHash: createHash('sha256').update(stable(payload)).digest('hex') };
}

/**
 * Makes Qdrant match the rows' current state. No point and eligible: embedded. A point whose
 * document changed: re-embedded. Unchanged document, changed payload: payload overwritten. Nothing
 * changed: nothing written. Ineligible or gone: point deleted. Idempotent, so a redelivered event
 * or a re-run page only repeats reads.
 */
export async function syncIds<P extends DomainPayload>(
  getDocs: GetDocs<P>,
  ids: number[],
  deps: DomainSyncDeps<P>
): Promise<SyncStats> {
  const stats = emptyStats();
  let pending = [...new Set(ids)];
  for (let round = 0; pending.length && round < MAX_ROUNDS; round++) {
    pending = await syncRound(getDocs, pending, deps, stats, round === 0);
  }
  stats.stale = pending.length;
  return stats;
}

/** Drops the payloads already stored exactly as they are; returns the rest, hashed for writing. */
function changedOnly<P extends DomainPayload>(
  payloads: Map<number, P>,
  stored: Map<number, Partial<P>>
): Map<number, P> {
  const out = new Map<number, P>();
  for (const [id, payload] of payloads) {
    const hashed = withPayloadHash(payload);
    if (stored.get(id)?.payloadHash !== hashed.payloadHash) out.set(id, hashed);
  }
  return out;
}

/** One pass; returns the ids whose document changed during the embed. */
async function syncRound<P extends DomainPayload>(
  getDocs: GetDocs<P>,
  ids: number[],
  deps: DomainSyncDeps<P>,
  stats: SyncStats,
  first: boolean
): Promise<number[]> {
  const [docs, points] = await Promise.all([
    getDocs(deps.pg, ids),
    deps.store.payloadFields(ids, ['docHash', 'payloadHash']),
  ]);
  if (first) stats.eligible += docs.size;

  const remove = ids.filter((id) => points.has(id) && !docs.has(id));
  const update = new Map<number, P>();
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
  const writes = changedOnly(update, points);
  const reembed = new Set(inputs.map((i) => Number(i.id)));
  stats.deleted += remove.length;
  // Payload-only syncs; a point awaiting its re-embed counts once, as embedded.
  for (const id of update.keys()) {
    if (reembed.has(id)) continue;
    if (writes.has(id)) stats.updated++;
    else stats.unchanged++;
  }
  if (deps.dryRun) {
    stats.embedded += inputs.length;
    return [];
  }
  await deps.store.delete(remove);
  await deps.store.setPayloads(writes);
  if (!inputs.length) return [];
  if (!deps.embedder) {
    stats.embedOff += inputs.length;
    return [];
  }

  const written = new Set<number>();
  const store = async (vectors: Map<number, number[]>) => {
    const fresh = [...vectors].filter(([id]) => !written.has(id));
    if (!fresh.length) return;
    await deps.store.upsert(
      fresh.map(([id, vector]) => ({ id, vector, payload: withPayloadHash(docs.get(id)!) }))
    );
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
  const now = await getDocs(deps.pg, [...written]);
  const lapsed = [...written].filter((id) => !now.has(id));
  const changed: number[] = [];
  const repayload = new Map<number, P>();
  for (const [id, payload] of now) {
    const embeddedHash = docs.get(id)!.docHash;
    if (payload.docHash !== embeddedHash) {
      changed.push(id);
      // As at the start of a round: current payload, the hash of the vector it sits on.
      repayload.set(id, { ...payload, docHash: embeddedHash });
    } else if (stable(payload) !== stable(docs.get(id))) repayload.set(id, payload);
  }
  await deps.store.delete(lapsed);
  await deps.store.setPayloads(
    new Map([...repayload].map(([id, p]) => [id, withPayloadHash(p)] as const))
  );
  stats.embedded -= lapsed.length;
  stats.deleted += lapsed.length;
  stats.updated += repayload.size - changed.length;

  if (result.error) throw result.error;
  return changed;
}

/** What a change event touches: a row of the domain, or a deleted child found through its payload. */
export type DomainRef = { id: number } | { child: number };

/**
 * One searchable type (models, articles, ...): where its rows live, how a row becomes a payload,
 * and which change events touch it. Images keep their own pipeline.
 */
export type Domain<P extends DomainPayload> = {
  /** Singular: logs say `<name>-sync`, and VECTOR_<NAME>_EMBED_ENABLED switches its embedding. */
  name: string;
  /** The table whose ids are the point ids; the backfill walks it. */
  table: string;
  getDocs: GetDocs<P>;
  /** Kafka topics carrying its changes, and the row each event touches. */
  topics: string[];
  refFromEvent: (topic: string, value: unknown) => DomainRef | null;
  /** Tables that must stream before it embeds, or an unpublish could miss the index. */
  cdcTables: string[];
  /** The payload field listing child ids, for a child delete that carries only its own id. */
  childField?: keyof P & string;
  /** The OutboxEntity whose search.update rows name this domain's ids. */
  outboxEntity?: string;
  /** VECTOR_<NAME>_EMBED_ENABLED unset: whether it embeds. True only for models, which predate it. */
  embedByDefault?: boolean;
  store: () => VectorStore<P>;
  alias: () => string;
};
