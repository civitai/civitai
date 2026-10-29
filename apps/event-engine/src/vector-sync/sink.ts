import { randomUUID } from 'node:crypto';
import { config } from '@/config';
import { logger } from '@/utils/logger';

/**
 * Full-width vectors, kept beside the truncated ones in Qdrant so a wider collection can be filled
 * later without re-embedding. Append-only shards in object storage, each a pair of .npy files:
 *
 *   <prefix><model>/<revision>/<profile>/d<dims>/<time>-<uuid>.vectors.npy   float16 [n, dims]
 *   <prefix><model>/<revision>/<profile>/d<dims>/<time>-<uuid>.ids.npy       int32   [n]
 *
 * Row i of one is the image id at row i of the other; the ids file is written second, so a
 * shard with one is complete. An image embedded twice appears in two shards with the same vector.
 * Nothing is ever deleted, so a re-ingest must re-check eligibility. Writing is best effort: a
 * failing store never holds up or fails the Qdrant path. Shards are retried while they fit the
 * buffer, then dropped and counted.
 */
export type SinkPut = (key: string, body: Uint8Array, signal: AbortSignal) => Promise<void>;

/** What produced a vector; each combination is its own series of shards. */
export type SinkSource = { model: string; revision: string; profile: string };

export type SinkStats = {
  buffered: number;
  written: number;
  failedFlushes: number;
  dropped: number;
};

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** IEEE 754 half precision bits of `v`, rounded to nearest even. */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1);
    const half = 1 << (shift - 1);
    if (rem > half || (rem === half && h & 1)) h++;
    return sign | h;
  }
  // A carry out of the mantissa rounds into the exponent, as it should.
  let h = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && h & 1)) h++;
  return sign | h;
}

/** The value of half precision bits, for tests and re-ingest. */
export function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (mant / 1024);
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + mant / 1024);
}

/** A .npy file (format 1.0): little-endian `descr` data of `shape`, header padded to 64 bytes. */
export function npy(descr: '<f2' | '<i4', shape: number[], data: Uint8Array): Uint8Array {
  const dict = `{'descr': '${descr}', 'fortran_order': False, 'shape': (${shape.join(', ')}${
    shape.length === 1 ? ',' : ''
  }), }`;
  const unpadded = 10 + dict.length + 1;
  const header = dict + ' '.repeat((64 - (unpadded % 64)) % 64) + '\n';
  const out = new Uint8Array(10 + header.length + data.length);
  out.set([0x93, ...Buffer.from('NUMPY'), 1, 0]);
  new DataView(out.buffer).setUint16(8, header.length, true);
  out.set(Buffer.from(header, 'latin1'), 10);
  out.set(data, 10 + header.length);
  return out;
}

type Shard = SinkSource & { dims: number; ids: number[]; rows: Uint16Array[] };

export class VectorSink {
  private open = new Map<string, Shard>();
  private ready: Shard[] = [];
  private flushing: Promise<void> | null = null;
  private timer?: NodeJS.Timeout;
  private stat = { written: 0, failedFlushes: 0, dropped: 0 };

  constructor(
    private readonly put: SinkPut,
    private readonly opts: {
      prefix?: string;
      shardSize?: number;
      /** Vectors held at most, open and unwritten shards together; beyond it the oldest go. */
      maxBuffered?: number;
      flushEveryMs?: number;
      /** A write not done by then counts as failed and is retried. */
      putTimeoutMs?: number;
    } = {}
  ) {
    const every = opts.flushEveryMs ?? 60_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.flush(true), every);
      this.timer.unref?.();
    }
  }

  /** Queues one vector. Never throws and never waits; a full shard is written in the background. */
  add(id: number, vector: number[], source: SinkSource) {
    if (!Number.isInteger(id) || id < 0 || id > 0x7fffffff) {
      // The ids file is int32.
      this.stat.dropped++;
      logger.warn({ id }, 'vector-sink: id does not fit int32; not kept');
      return;
    }
    const key = `${source.model}/${source.revision}/${source.profile}/${vector.length}`;
    let shard = this.open.get(key);
    if (!shard) {
      shard = { ...source, dims: vector.length, ids: [], rows: [] };
      this.open.set(key, shard);
    }
    const row = new Uint16Array(vector.length);
    for (let i = 0; i < vector.length; i++) row[i] = toHalf(vector[i]);
    shard.ids.push(id);
    shard.rows.push(row);
    if (shard.ids.length >= (this.opts.shardSize ?? 4096)) {
      this.open.delete(key);
      this.ready.push(shard);
    }
    this.trim();
    if (this.ready.length) void this.flush();
  }

  stats(): SinkStats {
    return { buffered: this.buffered(), ...this.stat };
  }

  /** Writes what is buffered, partial shards too; gives up after `timeoutMs` so a shutdown ends. */
  async close(timeoutMs = 15_000) {
    clearInterval(this.timer);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.flush(true), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
    clearTimeout(timer);
    const { buffered } = this.stats();
    if (buffered) logger.warn({ vectors: buffered }, 'vector-sink: closed with vectors unwritten');
  }

  /** Writes ready shards one at a time; `all` closes the open ones first. Never rejects. */
  flush(all = false): Promise<void> {
    if (all) {
      this.ready.push(...this.open.values());
      this.open.clear();
    }
    this.flushing ??= this.drain().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async drain() {
    while (this.ready.length) {
      const shard = this.ready[0];
      try {
        await this.write(shard);
        this.stat.written += shard.ids.length;
        this.ready.shift();
      } catch (err) {
        // Left in place: the next add or timer tries again, until the buffer bound drops it.
        this.stat.failedFlushes++;
        logger.warn({ err, vectors: shard.ids.length }, 'vector-sink: shard write failed');
        return;
      }
    }
  }

  private async write({ model, revision, profile, dims, ids, rows }: Shard) {
    const base = `${this.opts.prefix ?? ''}${model}/${revision}/${profile}/d${dims}/${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}-${randomUUID()}`;
    const data = new Uint8Array(rows.length * dims * 2);
    const view = new DataView(data.buffer);
    rows.forEach((row, r) => row.forEach((h, i) => view.setUint16((r * dims + i) * 2, h, true)));
    const idData = new Uint8Array(ids.length * 4);
    const idView = new DataView(idData.buffer);
    ids.forEach((id, i) => idView.setInt32(i * 4, id, true));
    // Vectors first: a shard whose ids file exists is complete.
    await this.timedPut(`${base}.vectors.npy`, npy('<f2', [rows.length, dims], data));
    await this.timedPut(`${base}.ids.npy`, npy('<i4', [ids.length], idData));
  }

  /** A hung write would otherwise hold the sink for the life of the process. */
  private async timedPut(key: string, body: Uint8Array) {
    const ms = this.opts.putTimeoutMs ?? 120_000;
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.put(key, body, abort.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error(`sink write timed out after ${ms} ms`));
          }, ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private buffered() {
    let n = 0;
    for (const s of this.ready) n += s.ids.length;
    for (const s of this.open.values()) n += s.ids.length;
    return n;
  }

  private trim() {
    const max = this.opts.maxBuffered ?? 16_384;
    // Oldest unwritten shard first, never the one a flush is writing now.
    while (this.buffered() > max && this.ready.length > (this.flushing ? 1 : 0)) {
      const dropped = this.ready.splice(this.flushing ? 1 : 0, 1)[0];
      this.stat.dropped += dropped.ids.length;
      logger.warn({ vectors: dropped.ids.length }, 'vector-sink: buffer full; dropped a shard');
    }
  }
}

/** The configured S3-compatible sink, or null when none is set. */
export function sinkFromConfig(): VectorSink | null {
  const { bucket, endpoint, region, accessKeyId, secretAccessKey, prefix } = config.vectorSync.sink;
  if (!bucket) return null;
  // Loaded on the first write, so a process without a sink never loads the SDK.
  let put: Promise<SinkPut> | undefined;
  const connect = async (): Promise<SinkPut> => {
    const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = new S3Client({
      region: region || 'auto',
      endpoint: endpoint || undefined,
      forcePathStyle: !!endpoint,
      credentials: accessKeyId ? { accessKeyId, secretAccessKey } : undefined,
    });
    return async (Key, Body, abortSignal) =>
      void (await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body }), { abortSignal }));
  };
  return new VectorSink(
    async (key, body, signal) => {
      // A failed connect is retried by the next write, not cached.
      put ??= connect().catch((err) => {
        put = undefined;
        throw err;
      });
      await (
        await put
      )(key, body, signal);
    },
    { prefix }
  );
}
