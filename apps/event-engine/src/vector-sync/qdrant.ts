import { QdrantClient, type Schemas } from '@qdrant/js-client-rest';
import { config } from '@/config';
import { retryOnceOnConnectionError } from '@/common/utils/connection-errors';
import { logger } from '@/utils/logger';
import type { ImagePayload } from './source';

export const VECTOR_DIMENSIONS = 256;
export const EMBED_MODEL = 'wemm-2b';

// On disk, all of them: RAM is budgeted for the quantized vectors. Ids and tags are only ever
// matched, so they skip the range index; nsfwLevel is filtered by range and match. userId (an
// exclusion) and postId (not a search filter) get no payload-aware HNSW links.
export type PayloadIndexes<P> = Array<[keyof P & string, Schemas['PayloadSchemaParams']]>;

const PAYLOAD_INDEXES: PayloadIndexes<ImagePayload> = [
  ['nsfwLevel', { type: 'integer', lookup: true, range: true, on_disk: true }],
  ['tagIds', { type: 'integer', lookup: true, range: false, on_disk: true }],
  ['baseModels', { type: 'keyword', on_disk: true }],
  ['type', { type: 'keyword', on_disk: true }],
  ['userId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
  ['postId', { type: 'integer', lookup: true, range: false, on_disk: true, enable_hnsw: false }],
  ['sortAt', { type: 'datetime', on_disk: true }],
];

/** What produced the vectors in a collection. A mismatch means a new collection, never a mixed one. */
export type ModelStamp = {
  model: string;
  modelRevision: string;
  /** Image preprocessing profile; an embed of video only reports `videoProfile`. */
  profile?: string;
  videoProfile?: string;
  dimensions: number;
};

export class ModelMismatchError extends Error {
  constructor(stored: Partial<ModelStamp>, got: ModelStamp) {
    super(
      `Embedder returned ${got.model}@${got.modelRevision} (${
        got.profile ?? got.videoProfile
      }) but the collection holds ${stored.model}@${stored.modelRevision} (${stored.profile}/${
        stored.videoProfile
      }). Create a new collection and swap the alias.`
    );
    this.name = 'ModelMismatchError';
  }
}

function stampConflicts(stored: Partial<ModelStamp>, got: ModelStamp) {
  return !!(
    (stored.model && stored.model !== got.model) ||
    (stored.dimensions && stored.dimensions !== got.dimensions) ||
    (stored.modelRevision && stored.modelRevision !== got.modelRevision) ||
    (stored.profile && got.profile && stored.profile !== got.profile) ||
    (stored.videoProfile && got.videoProfile && stored.videoProfile !== got.videoProfile)
  );
}

export type VectorPoint<P = ImagePayload> = { id: number; vector: number[]; payload: P };

/** What a collection is created with. Images keep their original settings. */
export type CollectionSpec<P> = {
  indexes: PayloadIndexes<P>;
  quantile: number;
  /** Unset keeps Qdrant's default of 1, which the single-node image instance runs on. */
  replicationFactor?: number;
  writeConsistencyFactor?: number;
};

/**
 * Every non-image collection lives on the 3-node site-search instance: two copies of each shard,
 * and a write is acknowledged by one so a node down never stalls the sync.
 */
export const SITE_REPLICATION = { replicationFactor: 2, writeConsistencyFactor: 1 } as const;
const IMAGE_COLLECTION: CollectionSpec<ImagePayload> = { indexes: PAYLOAD_INDEXES, quantile: 1.0 };

/** The client every vector store is built on. */
export function qdrantClient() {
  const { qdrantUrl, qdrantApiKey } = config.vectorSync;
  return new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey });
}

/**
 * Runs a Qdrant call again, once, when it failed because its pooled keep-alive socket had already
 * been closed by the server (see connection-errors). Not every request on such a socket reaches
 * the server, so the retry is only for calls that are safe to repeat: reads, upserts and payload
 * overwrites by point id, deletes by point id, and metadata merges all leave the same state when
 * applied twice. The bootstrap creates (collection, payload index, alias) are not retried, since a
 * repeat may fail as already existing. HTTP error responses and timeouts are never retried.
 */
const idempotent = retryOnceOnConnectionError;

export class VectorStore<P extends Record<string, unknown> = ImagePayload> {
  constructor(
    readonly client: QdrantClient,
    readonly collection: string,
    readonly spec: CollectionSpec<P> = IMAGE_COLLECTION as unknown as CollectionSpec<P>
  ) {}

  static fromConfig() {
    return new VectorStore(qdrantClient(), config.vectorSync.collection);
  }

  async exists() {
    return (await idempotent(() => this.client.collectionExists(this.collection))).exists;
  }

  /** Creates the collection, payload indexes and alias if missing. Safe to re-run. */
  async bootstrap({ alias = config.vectorSync.alias }: { alias?: string } = {}) {
    if (!(await this.exists())) {
      // Mirrors the configuration the vector-search benchmark measured.
      await this.client.createCollection(this.collection, {
        vectors: { size: VECTOR_DIMENSIONS, distance: 'Cosine', on_disk: true },
        hnsw_config: { m: 16, ef_construct: 128, on_disk: true },
        quantization_config: {
          scalar: { type: 'int8', quantile: this.spec.quantile, always_ram: true },
        },
        on_disk_payload: true,
        replication_factor: this.spec.replicationFactor,
        write_consistency_factor: this.spec.writeConsistencyFactor,
        metadata: { model: EMBED_MODEL, dimensions: VECTOR_DIMENSIONS },
      });
      logger.info({ collection: this.collection }, 'vector-sync: created collection');
    }

    const info = await idempotent(() => this.client.getCollection(this.collection));
    for (const [field, schema] of this.spec.indexes) {
      if (info.payload_schema?.[field]) continue;
      await this.client.createPayloadIndex(this.collection, {
        field_name: field,
        field_schema: schema,
        wait: true,
      });
    }

    const { aliases } = await idempotent(() => this.client.getAliases());
    const current = aliases.find((a) => a.alias_name === alias);
    // Only claims a free alias. Moving one that points elsewhere is a cutover, done by hand.
    if (!current) {
      await this.client.updateCollectionAliases({
        actions: [{ create_alias: { collection_name: this.collection, alias_name: alias } }],
      });
    } else if (current.collection_name !== this.collection) {
      logger.warn(
        { alias, points: current.collection_name, collection: this.collection },
        'vector-sync: alias points at another collection; leaving it'
      );
    }
  }

  /**
   * Refuses vectors from a model other than the one the collection was filled with. The first
   * successful embed records the revision and profiles. The read-back after recording catches some
   * concurrent claims, not all: Qdrant metadata has no compare-and-set.
   */
  assertModel(got: ModelStamp): Promise<void> {
    // Recorded fields are only added, never overwritten, so a confirmed stamp stays confirmed.
    if (this.confirmed.has(JSON.stringify(got))) return Promise.resolve();
    // Serialised so concurrent first writers can't both read an empty stamp (see the doc).
    const next = this.modelCheck.then(() => this.checkModel(got));
    this.modelCheck = next.catch(() => undefined);
    return next;
  }

  private modelCheck: Promise<unknown> = Promise.resolve();
  private readonly confirmed = new Set<string>();

  private async checkModel(got: ModelStamp) {
    const stored = await this.readStamp();
    if (stampConflicts(stored, got)) throw new ModelMismatchError(stored, got);

    const missing: Partial<ModelStamp> = {};
    if (!stored.modelRevision) missing.modelRevision = got.modelRevision;
    if (!stored.profile && got.profile) missing.profile = got.profile;
    if (!stored.videoProfile && got.videoProfile) missing.videoProfile = got.videoProfile;
    if (Object.keys(missing).length) {
      await idempotent(() => this.client.updateCollection(this.collection, { metadata: missing }));
      const after = await this.readStamp();
      if (stampConflicts(after, got)) throw new ModelMismatchError(after, got);
    }
    this.confirmed.add(JSON.stringify(got));
  }

  /** Whether a model revision has been recorded. Once true it stays true, so it is cached. */
  async isStamped() {
    // The image profile too: a video-only first fill leaves it for a later writer to record.
    const stored = await this.readStamp();
    this.stamped ||= !!stored.modelRevision && !!stored.profile;
    return this.stamped;
  }

  private stamped = false;

  private async readStamp(): Promise<Partial<ModelStamp>> {
    const info = await idempotent(() => this.client.getCollection(this.collection));
    return (info.config.metadata ?? {}) as Partial<ModelStamp>;
  }

  async upsert(points: VectorPoint<P>[]) {
    if (!points.length) return;
    await idempotent(() => this.client.upsert(this.collection, { wait: true, points }));
  }

  async delete(ids: number[]) {
    if (!ids.length) return;
    await idempotent(() => this.client.delete(this.collection, { wait: true, points: ids }));
  }

  /** Overwrites the payload of points that exist; ids with no point are ignored by the caller. */
  async setPayloads(payloads: Map<number, P>) {
    if (!payloads.size) return;
    await idempotent(() =>
      this.client.batchUpdate(this.collection, {
        wait: true,
        operations: [...payloads].map(([id, payload]) => ({
          overwrite_payload: { payload, points: [id] },
        })),
      })
    );
  }

  /** The named payload fields of the points among `ids` that exist. */
  async payloadFields(ids: number[], fields: Array<keyof P & string>) {
    if (!ids.length) return new Map<number, Partial<P>>();
    const points = await idempotent(() =>
      this.client.retrieve(this.collection, {
        ids,
        with_payload: { include: fields },
        with_vector: false,
      })
    );
    return new Map(points.map((p) => [Number(p.id), (p.payload ?? {}) as Partial<P>]));
  }

  /** Merges keys into the collection metadata. */
  async setMetadata(metadata: Record<string, string | number>) {
    await idempotent(() => this.client.updateCollection(this.collection, { metadata }));
  }

  async count() {
    return (await idempotent(() => this.client.count(this.collection, { exact: true }))).count;
  }

  /** The subset of `ids` that have a point. */
  async existing(ids: number[]): Promise<Set<number>> {
    if (!ids.length) return new Set();
    const points = await idempotent(() =>
      this.client.retrieve(this.collection, {
        ids,
        with_payload: false,
        with_vector: false,
      })
    );
    return new Set(points.map((p) => Number(p.id)));
  }

  /** Ids of the points whose integer `field` holds any of `values`. */
  async idsMatching(field: keyof P & string, values: number[], pageSize = 1_000) {
    const ids: number[] = [];
    let offset: string | number | undefined;
    if (!values.length) return ids;
    do {
      const page = await idempotent(() =>
        this.client.scroll(this.collection, {
          filter: { must: [{ key: field, match: { any: values } }] },
          offset,
          limit: pageSize,
          with_payload: false,
          with_vector: false,
        })
      );
      ids.push(...page.points.map((p) => Number(p.id)));
      offset = page.next_page_offset == null ? undefined : (page.next_page_offset as number);
    } while (offset !== undefined);
    return ids;
  }

  /** Point ids with lo <= id < hi. Scroll walks ids in ascending order from `offset`. */
  async idsInRange(lo: number, hi: number, pageSize = 10_000): Promise<number[]> {
    const ids: number[] = [];
    let offset: number | undefined = lo;
    while (offset !== undefined && offset < hi) {
      const page = await idempotent(() =>
        this.client.scroll(this.collection, {
          offset,
          limit: pageSize,
          with_payload: false,
          with_vector: false,
        })
      );
      for (const point of page.points) {
        const id = Number(point.id);
        if (id >= hi) return ids;
        ids.push(id);
      }
      offset = page.next_page_offset == null ? undefined : Number(page.next_page_offset);
    }
    return ids;
  }
}
