import { logger } from '@/utils/logger';
import { MixedStampError } from '../embedder';
import { recordFlush, timeEmbeds, vectorSyncMetrics } from '../metrics';
import { ModelMismatchError, type VectorStore } from '../qdrant';
import {
  syncIds,
  type Domain,
  type DomainPayload,
  type DomainRef,
  type DomainSyncDeps,
} from './sync';

export type Offset = { topic: string; partition: number; offset: string };

export type LaneDeps<P extends DomainPayload> = Omit<DomainSyncDeps<P>, 'store'> & {
  store: DomainSyncDeps<P>['store'] & Pick<VectorStore<P>, 'isStamped' | 'idsMatching'>;
};

/** One domain's pending ids and embedding state inside a queue. */
export class SyncLane<P extends DomainPayload> {
  private pending = new Set<number>();
  /** Deleted children, resolved to their rows at flush. */
  private children = new Set<number>();
  embedStopped: string | null = null;
  gateBlocked: string | null = null;
  /** The collection has no recorded model yet, so nothing embeds. */
  unstamped = false;
  readonly deps: LaneDeps<P>;

  constructor(readonly domain: Domain<P>, deps: LaneDeps<P>, onProgress: () => void) {
    // Progress is vectors stored, not returned: a flush whose writes keep failing would otherwise
    // read as slow, stay healthy, and pay to re-embed the same rows every tick.
    const { store } = deps;
    this.deps = {
      ...deps,
      store: {
        payloadFields: (...a) => store.payloadFields(...a),
        delete: (...a) => store.delete(...a),
        setPayloads: (...a) => store.setPayloads(...a),
        assertModel: (...a) => store.assertModel(...a),
        isStamped: () => store.isStamped(),
        idsMatching: (...a) => store.idsMatching(...a),
        upsert: async (...a) => {
          await store.upsert(...a);
          onProgress();
        },
      },
    };
  }

  private get log() {
    return `${this.domain.name}-sync`;
  }

  add(ref: DomainRef) {
    if ('id' in ref) this.pending.add(ref.id);
    else this.children.add(ref.child);
  }

  get size() {
    return this.pending.size + this.children.size;
  }

  get embedding() {
    return !!this.deps.embedder && !this.embedStopped && !this.gateBlocked && !this.unstamped;
  }

  /** Syncs everything pending; on failure puts it back and rethrows. */
  async flush() {
    const ids = [...this.pending];
    const children = [...this.children];
    this.pending = new Set();
    this.children = new Set();
    try {
      const field = this.domain.childField;
      if (children.length && !field)
        logger.warn({ children: children.length }, `${this.log}: child deletes but no childField`);
      if (children.length && field) {
        // No match: no point holds the child, or the point predates the field.
        const owners = await this.deps.store.idsMatching(field, children);
        if (!owners.length)
          logger.info(
            { [field]: children.length },
            `${this.log}: deleted ${field} matched no point`
          );
        ids.push(...owners);
      }
      if (!ids.length) return;
      // A new collection's model is recorded by the backfill canary first, so two writers
      // cannot stamp it differently.
      const embed = !!this.deps.embedder && !this.gateBlocked && (await this.refreshStamp());
      const started = Date.now();
      const { embedder } = this.deps;
      const stats = await syncIds(this.domain.getDocs, ids, {
        ...this.deps,
        embedder: embed && embedder ? timeEmbeds(this.domain.name, embedder) : null,
      });
      recordFlush(this.domain.name, stats);
      logger.info({ ids: ids.length, ms: Date.now() - started, ...stats }, `${this.log}: flushed`);
    } catch (err) {
      vectorSyncMetrics.flushErrors.inc({ domain: this.domain.name });
      for (const id of ids) this.pending.add(id);
      for (const c of children) this.children.add(c);
      if (err instanceof ModelMismatchError || err instanceof MixedStampError) {
        // Retrying would pay for the same rejected vectors every tick.
        this.stopEmbedding((err as Error).message);
      }
      throw err;
    }
  }

  /** Whether the collection has a recorded model; logs once when it does not. */
  async refreshStamp() {
    const stamped = await this.deps.store.isStamped();
    if (!stamped && !this.unstamped)
      logger.warn(`${this.log}: collection has no recorded model yet; not embedding`);
    this.unstamped = !stamped;
    return stamped;
  }

  setGate(reason: string | null) {
    if (reason !== this.gateBlocked) {
      if (reason) logger.warn({ reason }, `${this.log}: embedding paused`);
      else logger.info(`${this.log}: embedding resumed`);
    }
    this.gateBlocked = reason;
  }

  stopEmbedding(reason: string) {
    if (!this.deps.embedder) return;
    logger.error({ reason }, `${this.log}: embedding stopped`);
    this.deps.embedder = null;
    this.embedStopped = reason;
  }
}

const MAX_PENDING = 2_000;

/**
 * Collects ids per domain and syncs them every `debounceMs`, committing offsets only once the
 * Qdrant writes for everything before them have succeeded in every domain; a crash redelivers,
 * which the sync absorbs. While a domain's embedding is off, paused or its collection unstamped,
 * deletes and payload updates still run, and rows needing a vector are left for the backfill.
 */
export class DomainSyncQueue {
  readonly lanes = new Map<string, SyncLane<any>>();
  private offsets = new Map<string, Offset>();
  private flushing: Promise<void> | null = null;
  lastFlushOk = Date.now();
  /** Vectors stored, or a flush succeeding. */
  lastProgress = Date.now();
  consecutiveFailures = 0;
  private progressCount = 0;

  constructor(
    lanes: Array<{ domain: Domain<any>; deps: LaneDeps<any> }>,
    private readonly commit: (offsets: Offset[]) => Promise<void>,
    private readonly log = 'vector-sync'
  ) {
    for (const { domain, deps } of lanes)
      this.lanes.set(domain.name, new SyncLane(domain, deps, () => this.noteProgress()));
  }

  /** Records the message's offset, and the row it touches when there is one. */
  add(domain: string | null, ref: DomainRef | null, offset: Offset) {
    if (domain && ref) this.lanes.get(domain)?.add(ref);
    this.offsets.set(`${offset.topic}:${offset.partition}`, offset);
  }

  get size() {
    let n = 0;
    for (const lane of this.lanes.values()) n += lane.size;
    return n;
  }

  get isFull() {
    return this.size >= MAX_PENDING;
  }

  flush(): Promise<void> {
    this.flushing ??= this.doFlush().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush() {
    const progressAtStart = this.progressCount;
    const offsets = [...this.offsets.values()];
    this.offsets = new Map();
    // Every lane runs, so one domain's outage does not stall the others' writes; offsets wait
    // for all of them.
    const results = await Promise.allSettled([...this.lanes.values()].map((l) => l.flush()));
    const lanes = [...this.lanes.keys()];
    const failed = results.flatMap((r, i) =>
      r.status === 'rejected' ? [[lanes[i], r.reason]] : []
    );
    // Each lane's error, since only the first is rethrown; one stuck lane holds every offset.
    for (const [domain, err] of failed)
      logger.error({ err, domain }, `${this.log}: lane flush failed`);
    const failure = failed[0] && { reason: failed[0][1] };
    if (failure) {
      for (const o of offsets) {
        const key = `${o.topic}:${o.partition}`;
        if (!this.offsets.has(key)) this.offsets.set(key, o);
      }
      // A flush that stored some vectors before failing is slow, not stuck.
      if (this.progressCount === progressAtStart) this.consecutiveFailures++;
      else this.consecutiveFailures = 0;
      throw failure.reason;
    }
    if (offsets.length) {
      try {
        await this.commit(
          offsets.map((o) => ({ ...o, offset: (BigInt(o.offset) + 1n).toString() }))
        );
      } catch (err) {
        logger.warn({ err }, `${this.log}: offset commit failed`);
      }
    }
    this.lastFlushOk = Date.now();
    this.lastProgress = this.lastFlushOk;
    this.consecutiveFailures = 0;
  }

  noteProgress() {
    this.progressCount++;
    this.lastProgress = Date.now();
  }

  /**
   * Healthy within 10 minutes of a successful flush. Past that, a flush still storing vectors
   * stays healthy (killing it would lose paid work), but not one whose flushes keep failing
   * without progress. 45 minutes outlasts a batch's rate-limit backoff plus the 30-minute
   * workflow timeout.
   */
  isHealthy(now = Date.now()) {
    if (now - this.lastFlushOk < 10 * 60_000) return true;
    return this.consecutiveFailures < 3 && now - this.lastProgress < 45 * 60_000;
  }
}
