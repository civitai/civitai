import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '@/config';
import { logger } from '@/utils/logger';
import type { ImagePayload } from './source';

export const VECTOR_DIMENSIONS = 256;
export const EMBED_MODEL = 'wemm-2b';

const PAYLOAD_INDEXES: Array<[keyof ImagePayload, 'integer' | 'keyword' | 'datetime']> = [
  ['nsfwLevel', 'integer'],
  ['tagIds', 'integer'],
  ['baseModels', 'keyword'],
  ['type', 'keyword'],
  ['userId', 'integer'],
  ['postId', 'integer'],
  ['sortAt', 'datetime'],
];

/** What produced the vectors in a collection. A mismatch means a new collection, never a mixed one. */
export type ModelStamp = {
  model: string;
  modelRevision: string;
  profile: string;
  videoProfile?: string;
  dimensions: number;
};

export class ModelMismatchError extends Error {
  constructor(stored: Partial<ModelStamp>, got: ModelStamp) {
    super(
      `Embedder returned ${got.model}@${got.modelRevision} (${got.profile}) but the collection holds ${stored.model}@${stored.modelRevision} (${stored.profile}). Create a new collection and swap the alias.`
    );
    this.name = 'ModelMismatchError';
  }
}

function stampConflicts(stored: Partial<ModelStamp>, got: ModelStamp) {
  return !!(
    (stored.model && stored.model !== got.model) ||
    (stored.dimensions && stored.dimensions !== got.dimensions) ||
    (stored.modelRevision && stored.modelRevision !== got.modelRevision) ||
    (stored.profile && stored.profile !== got.profile) ||
    (stored.videoProfile && got.videoProfile && stored.videoProfile !== got.videoProfile)
  );
}

export type VectorPoint = { id: number; vector: number[]; payload: ImagePayload };

export class VectorStore {
  constructor(readonly client: QdrantClient, readonly collection: string) {}

  static fromConfig() {
    const { qdrantUrl, qdrantApiKey, collection } = config.vectorSync;
    return new VectorStore(new QdrantClient({ url: qdrantUrl, apiKey: qdrantApiKey }), collection);
  }

  /** Creates the collection, payload indexes and alias if missing. Safe to re-run. */
  async bootstrap({ alias = config.vectorSync.alias }: { alias?: string } = {}) {
    const { exists } = await this.client.collectionExists(this.collection);
    if (!exists) {
      // Mirrors the configuration the vector-search benchmark measured.
      await this.client.createCollection(this.collection, {
        vectors: { size: VECTOR_DIMENSIONS, distance: 'Cosine', on_disk: true },
        hnsw_config: { m: 16, ef_construct: 128, on_disk: true },
        quantization_config: { scalar: { type: 'int8', quantile: 1.0, always_ram: true } },
        on_disk_payload: true,
        metadata: { model: EMBED_MODEL, dimensions: VECTOR_DIMENSIONS },
      });
      logger.info({ collection: this.collection }, 'vector-sync: created collection');
    }

    const info = await this.client.getCollection(this.collection);
    for (const [field, schema] of PAYLOAD_INDEXES) {
      if (info.payload_schema?.[field]) continue;
      await this.client.createPayloadIndex(this.collection, {
        field_name: field,
        field_schema: schema,
        wait: true,
      });
    }

    const { aliases } = await this.client.getAliases();
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
   * successful embed records the revision and profiles. Read on every call rather than cached,
   * because another process may have recorded them. The read-back after recording catches some
   * concurrent claims, not all: Qdrant metadata has no compare-and-set.
   */
  assertModel(got: ModelStamp): Promise<void> {
    // Serialised within the process: concurrent first writers would otherwise both read an empty
    // stamp. Across processes there is no compare-and-set, so a new collection's first fill
    // should come from one process (see the doc).
    const next = this.modelCheck.then(() => this.checkModel(got));
    this.modelCheck = next.catch(() => undefined);
    return next;
  }

  private modelCheck: Promise<unknown> = Promise.resolve();

  private async checkModel(got: ModelStamp) {
    const stored = await this.readStamp();
    if (stampConflicts(stored, got)) throw new ModelMismatchError(stored, got);

    const missing: Partial<ModelStamp> = {};
    if (!stored.modelRevision) missing.modelRevision = got.modelRevision;
    if (!stored.profile) missing.profile = got.profile;
    if (!stored.videoProfile && got.videoProfile) missing.videoProfile = got.videoProfile;
    if (!Object.keys(missing).length) return;
    await this.client.updateCollection(this.collection, { metadata: missing });
    const after = await this.readStamp();
    if (stampConflicts(after, got)) throw new ModelMismatchError(after, got);
  }

  private async readStamp(): Promise<Partial<ModelStamp>> {
    const info = await this.client.getCollection(this.collection);
    return (info.config.metadata ?? {}) as Partial<ModelStamp>;
  }

  async upsert(points: VectorPoint[]) {
    if (!points.length) return;
    await this.client.upsert(this.collection, { wait: true, points });
  }

  async delete(ids: number[]) {
    if (!ids.length) return;
    await this.client.delete(this.collection, { wait: true, points: ids });
  }

  /** Overwrites the payload of points that exist; ids with no point are ignored by the caller. */
  async setPayloads(payloads: Map<number, ImagePayload>) {
    if (!payloads.size) return;
    await this.client.batchUpdate(this.collection, {
      wait: true,
      operations: [...payloads].map(([id, payload]) => ({
        overwrite_payload: { payload, points: [id] },
      })),
    });
  }

  /** The subset of `ids` that have a point. */
  async existing(ids: number[]): Promise<Set<number>> {
    if (!ids.length) return new Set();
    const points = await this.client.retrieve(this.collection, {
      ids,
      with_payload: false,
      with_vector: false,
    });
    return new Set(points.map((p) => Number(p.id)));
  }

  /** Point ids with lo <= id < hi. Scroll walks ids in ascending order from `offset`. */
  async idsInRange(lo: number, hi: number, pageSize = 10_000): Promise<number[]> {
    const ids: number[] = [];
    let offset: number | undefined = lo;
    while (offset !== undefined && offset < hi) {
      const page = await this.client.scroll(this.collection, {
        offset,
        limit: pageSize,
        with_payload: false,
        with_vector: false,
      });
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
