import { endianness } from 'os';
import { once } from 'events';
import zlib from 'zlib';
import type { SparseByKey, TagIndexData, TagIndexKindData } from './build';
import { stepEvery, tagFitBound, type Step } from './build';
import {
  assembleTagIndex,
  C_SCALE,
  decodeTagIndexData as decodeTagIndexDataWith,
  single,
  TAG_INDEX_DECODE_CAPS,
  TAG_INDEX_MAX_PAYLOAD_BYTES,
  TAG_INDEX_PAYLOAD_FORMAT,
  unpackTagIndexData,
  validateTagIndexData as validateTagIndexDataWith,
  type DecodedTagIndex,
  type TagIndexDecodeCaps,
  type Wide,
} from './payload-decode';
import type { TagIndex } from './score';

/**
 * The content-tag index snapshot: msgpack + brotli, with the vocabulary embedded and its version and
 * the spec hash in the header. Lossless against the build except for float32 values (idf stays
 * float64): content scores, which the build rounds to 4 decimals, travel as exact integers c·10⁴;
 * ascending ids as deltas; CSR pointers as row lengths; a pair fit only where the pair has one, under
 * a presence bitmap; every multi-byte array byte-plane shuffled (for brotli). `tagIndexFromData`
 * refuses any index that breaks a precondition the scorer (`./score`) relies on, decoded or built in
 * memory. This module encodes; the decoder lives in `./payload-decode` (re-exported here), so the
 * decode worker can bundle it alone.
 */

export {
  ASSEMBLE_STEP_WORK,
  assembleTagIndex,
  assembleTagIndexCooperative,
  decompressTagIndex,
  TAG_INDEX_DECODE_CAPS,
  TAG_INDEX_MAX_INFLATED_BYTES,
  TAG_INDEX_MAX_PAYLOAD_BYTES,
  TAG_INDEX_PAYLOAD_FORMAT,
  transferablesOf,
  unpackTagIndexData,
} from './payload-decode';
export type { DecodedTagIndex, TagIndexDecodeCaps } from './payload-decode';

const BROTLI_QUALITY = 9;
const LITTLE_ENDIAN = endianness() === 'LE';

/** A CSR pointer as its row lengths. */
const lengths = (ptr: Uint32Array) =>
  Uint32Array.from({ length: ptr.length - 1 }, (_, i) => ptr[i + 1] - ptr[i]);

/** Ids as differences from the previous id of the same row (the first of a row as is). */
function deltas(ptr: Uint32Array, ids: Uint32Array): Uint32Array {
  const out = new Uint32Array(ids.length);
  for (let i = 0; i + 1 < ptr.length; i++)
    for (let k = ptr[i]; k < ptr[i + 1]; k++) out[k] = k > ptr[i] ? ids[k] - ids[k - 1] : ids[k];
  return out;
}

/** Units of work (bytes or elements) between pauses of `encodeTagIndexCooperative`. */
const PACK_STEP_WORK = 1 << 20;
/** Elements per inner run of the pack's loops, between step checks. */
const PACK_CHUNK = 1 << 16;

/** Output bytes in order; `null` is a pause point. */
type ByteStream = Generator<Uint8Array | null, void>;
type Chunk = { bytes: Uint8Array } | { len: number; write: () => ByteStream };

/**
 * Writes msgpack exactly as msgpackr (`useRecords: false`, `mapsAsObjects: true`) packs the same
 * document — every object a map16, every other header in its smallest form — producing each binary
 * only when the stream reaches it, so no shuffled copy of an array is held beside the output
 * (`resource-intent-tags.pack-writer.test.ts` holds the two byte for byte).
 */
class PackLayout {
  readonly chunks: Chunk[] = [];
  size = 0;
  private head(bytes: number[]) {
    this.chunks.push({ bytes: Uint8Array.from(bytes) });
    this.size += bytes.length;
  }
  map(n: number) {
    if (n > 0xffff) throw new Error('tag index: map too large');
    this.head([0xde, n >> 8, n & 0xff]);
  }
  str(s: string) {
    const b = Buffer.from(s, 'utf8');
    const n = b.length;
    if (n < 0x20) this.head([0xa0 | n]);
    else if (n < 0x100) this.head([0xd9, n]);
    else if (n < 0x10000) this.head([0xda, n >> 8, n & 0xff]);
    else this.head([0xdb, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
    this.chunks.push({ bytes: b });
    this.size += n;
  }
  strs(xs: readonly string[]) {
    const n = xs.length;
    if (n < 0x10) this.head([0x90 | n]);
    else if (n < 0x10000) this.head([0xdc, n >> 8, n & 0xff]);
    else this.head([0xdd, n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
    for (const x of xs) this.str(x);
  }
  uint(v: number) {
    if (!(Number.isInteger(v) && v >= 0 && v <= 0xffffffff))
      throw new Error(`tag index: ${v} is not a uint32`);
    if (v < 0x80) this.head([v]);
    else if (v < 0x100) this.head([0xcc, v]);
    else if (v < 0x10000) this.head([0xcd, v >> 8, v & 0xff]);
    else this.head([0xce, v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  }
  /** A binary of `len` bytes that `write` produces when the stream reaches it. */
  bin(len: number, write: () => ByteStream) {
    if (len < 0x100) this.head([0xc4, len]);
    else if (len < 0x10000) this.head([0xc5, len >> 8, len & 0xff]);
    else this.head([0xc6, len >>> 24, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]);
    this.chunks.push({ len, write });
    this.size += len;
  }
  /** `a`'s bytes, shuffled; `make` builds the array only when it is written. */
  shuffled(make: () => Wide, n: number, bytesPer: number, step: Step) {
    this.bin(n * bytesPer, () => shuffleChunks(make(), n * bytesPer, step));
  }
  raw(bytes: Uint8Array) {
    this.bin(bytes.length, function* () {
      yield bytes;
    });
  }
  /** The packed bytes in order, every binary produced only when reached; checks the total. */
  *stream(): ByteStream {
    let at = 0;
    for (const c of this.chunks) {
      if ('bytes' in c) {
        yield c.bytes;
        at += c.bytes.length;
      } else {
        let got = 0;
        for (const x of c.write()) {
          if (x) got += x.length;
          yield x;
        }
        if (got !== c.len) throw new Error('tag index: binary length mismatch');
        at += got;
      }
    }
    if (at !== this.size) throw new Error('tag index: packed size mismatch');
  }
}

/** Little-endian bytes, byte plane by byte plane: every element's byte 0, then every byte 1, … */
function* shuffleChunks(a: Wide, bytes: number, step: Step): ByteStream {
  const size = a.BYTES_PER_ELEMENT;
  const n = a.length;
  if (bytes !== n * size) throw new Error('tag index: shuffled length mismatch');
  let le: Uint8Array;
  if (LITTLE_ENDIAN) le = new Uint8Array(a.buffer, a.byteOffset, n * size);
  else {
    le = new Uint8Array(n * size);
    const dv = new DataView(le.buffer);
    if (a instanceof Uint16Array) for (let i = 0; i < n; i++) dv.setUint16(i * 2, a[i], true);
    else if (a instanceof Uint32Array) for (let i = 0; i < n; i++) dv.setUint32(i * 4, a[i], true);
    else if (a instanceof Float32Array)
      for (let i = 0; i < n; i++) dv.setFloat32(i * 4, a[i], true);
    else for (let i = 0; i < n; i++) dv.setFloat64(i * 8, a[i], true);
  }
  for (let b = 0; b < size; b++)
    for (let i0 = 0; i0 < n; i0 += PACK_CHUNK) {
      const end = Math.min(n, i0 + PACK_CHUNK);
      const out = Buffer.allocUnsafe(end - i0);
      for (let i = i0; i < end; i++) out[i - i0] = le[i * size + b];
      yield out;
      if (step(end - i0)) yield null;
    }
}

function sparseLayout(L: PackLayout, s: SparseByKey, integer: boolean, step: Step) {
  if (integer)
    for (const v of s.value)
      if (!Number.isInteger(v) || v < 0 || v > 0xffffffff)
        throw new Error(`tag index: count ${v} is not a uint32`);
  L.map(4);
  L.str('keys');
  L.shuffled(() => deltas(single(s.keys.length), s.keys), s.keys.length, 4, step);
  L.str('len');
  L.shuffled(() => lengths(s.ptr), s.ptr.length - 1, 4, step);
  L.str('resource');
  L.shuffled(() => deltas(s.ptr, s.resource), s.resource.length, 4, step);
  L.str('value');
  L.shuffled(
    () => (integer ? Uint32Array.from(s.value) : Float32Array.from(s.value)),
    s.value.length,
    4,
    step
  );
}

/**
 * A kind's arrays, laid out. Content scores are checked (and turned into integers) here, before any
 * byte is written. With `consume`, the postings' arrays are dropped from `k` once they are no longer
 * needed (the resource ids turned into deltas in place first), so a caller that hands the index over
 * does not hold it and its packed bytes at once.
 */
function* kindLayout(
  L: PackLayout,
  k: TagIndexKindData,
  step: Step,
  consume: boolean
): Generator<void> {
  const p = k.postings;
  const n = p.c.length;
  const present = new Uint8Array(Math.ceil(p.fit.length / 8));
  let nFits = 0;
  for (let i0 = 0; i0 < n; i0 += PACK_CHUNK) {
    const end = Math.min(n, i0 + PACK_CHUNK);
    const { fit } = p;
    for (let i = i0; i < end; i++) if (!Number.isNaN(fit[i])) nFits++;
    if (step(end - i0)) yield;
  }
  const fits = new Float32Array(nFits);
  let j = 0;
  const cInt = new Uint16Array(n);
  for (let i0 = 0; i0 < n; i0 += PACK_CHUNK) {
    const end = Math.min(n, i0 + PACK_CHUNK);
    const { c, fit } = p;
    // A multiple of 1/C_SCALE in c's own precision: float32 scores are the float32 of k/C_SCALE.
    const exact =
      c instanceof Float32Array
        ? (scaled: number, v: number) => Math.fround(scaled / C_SCALE) === v
        : (scaled: number, v: number) => Math.abs(scaled - v * C_SCALE) <= 1e-6;
    for (let i = i0; i < end; i++) {
      const scaled = Math.round(c[i] * C_SCALE);
      if (!(scaled >= 0 && scaled <= C_SCALE) || !exact(scaled, c[i]))
        throw new Error(
          `tag index: content score ${c[i]} is not a multiple of 1/${C_SCALE} in [0, 1]`
        );
      cInt[i] = scaled;
      if (!Number.isNaN(fit[i])) {
        present[i >> 3] |= 1 << (i & 7);
        fits[j++] = fit[i];
      }
    }
    if (step(end - i0)) yield;
  }
  if (consume) {
    p.c = new Float64Array(0);
    p.fit = new Float64Array(0);
  }
  L.map(8);
  L.str('modelIds');
  L.shuffled(() => deltas(single(k.modelIds.length), k.modelIds), k.modelIds.length, 4, step);
  L.str('fit');
  L.shuffled(() => Float32Array.from(k.fit), k.fit.length, 4, step);
  L.str('ecosystemLen');
  L.shuffled(() => lengths(k.ecosystemPtr), k.ecosystemPtr.length - 1, 4, step);
  L.str('ecosystemIds');
  L.shuffled(() => deltas(k.ecosystemPtr, k.ecosystemIds), k.ecosystemIds.length, 4, step);
  L.str('postings');
  L.map(5);
  L.str('len');
  L.shuffled(() => lengths(p.ptr), p.ptr.length - 1, 4, step);
  L.str('resource');
  L.bin(p.resource.length * 4, function* () {
    let ids = p.resource;
    if (consume) {
      // In place, a tag's list at a time.
      for (let t = 0; t + 1 < p.ptr.length; t++) {
        for (let k = p.ptr[t + 1] - 1; k > p.ptr[t]; k--) ids[k] -= ids[k - 1];
        if (step(p.ptr[t + 1] - p.ptr[t] + 1)) yield null;
      }
      p.resource = new Uint32Array(0);
    } else ids = deltas(p.ptr, ids);
    yield* shuffleChunks(ids, ids.length * 4, step);
  });
  L.str('c');
  L.shuffled(() => cInt, n, 2, step);
  L.str('fitPresent');
  L.raw(present);
  L.str('fit');
  L.shuffled(() => fits, nFits, 4, step);
  L.str('ecosystemUsers');
  sparseLayout(L, k.ecosystemUsers, true, step);
  L.str('userByTag');
  sparseLayout(L, k.userByTag, false, step);
  L.str('userByEcosystem');
  sparseLayout(L, k.userByEcosystem, false, step);
}

function* layoutSteps(
  data: TagIndexData,
  specHash: string,
  step: Step,
  consume: boolean
): Generator<void, PackLayout> {
  const v = data.vocabulary;
  const nearPtr = new Uint32Array(v.length + 1);
  v.forEach((t, i) => (nearPtr[i + 1] = nearPtr[i] + t.near.length));
  const tc = data.tagEcosystemCounts;
  const L = new PackLayout();
  L.map(8);
  L.str('format');
  L.str(TAG_INDEX_PAYLOAD_FORMAT);
  L.str('vocabVersion');
  L.str(data.vocabVersion);
  L.str('specHash');
  L.str(specHash);
  L.str('rowsWithEcosystem');
  L.uint(data.rowsWithEcosystem);
  L.str('vocabulary');
  L.map(6);
  L.str('keys');
  L.strs(v.map((t) => t.key));
  L.str('users');
  L.shuffled(() => Uint32Array.from(v, (t) => t.users), v.length, 4, step);
  L.str('idf');
  L.shuffled(() => Float64Array.from(v, (t) => t.idf), v.length, 8, step);
  L.str('explicit');
  L.raw(Uint8Array.from(v, (t) => (t.explicit ? 1 : 0)));
  L.str('nearLen');
  L.shuffled(() => lengths(nearPtr), v.length, 4, step);
  L.str('near');
  L.shuffled(
    () => deltas(nearPtr, Uint32Array.from(v.flatMap((t) => t.near))),
    nearPtr[v.length],
    4,
    step
  );
  L.str('ecosystems');
  L.map(3);
  L.str('names');
  L.strs(data.ecosystems.map((e) => e.name));
  L.str('users');
  L.shuffled(
    () => Uint32Array.from(data.ecosystems, (e) => e.users),
    data.ecosystems.length,
    4,
    step
  );
  L.str('observations');
  L.shuffled(
    () => Uint32Array.from(data.ecosystems, (e) => e.observations),
    data.ecosystems.length,
    4,
    step
  );
  L.str('tagEcosystemCounts');
  L.map(3);
  L.str('len');
  L.shuffled(() => lengths(tc.ptr), tc.ptr.length - 1, 4, step);
  L.str('ecosystem');
  L.shuffled(() => deltas(tc.ptr, tc.ecosystem), tc.ecosystem.length, 4, step);
  L.str('count');
  L.shuffled(() => tc.count, tc.count.length, 4, step);
  L.str('kinds');
  L.map(2);
  L.str('addon');
  yield* kindLayout(L, data.kinds.addon, step, consume);
  L.str('checkpoint');
  yield* kindLayout(L, data.kinds.checkpoint, step, consume);
  return L;
}

/** Drives `layoutSteps` to its layout, awaiting `pause` at each of its pause points. */
async function layoutOf(steps: Generator<void, PackLayout>, pause: () => Promise<void>) {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    await pause();
  }
}

/** Uncompressed bytes: what the spec hash fingerprints. */
export function packTagIndex(data: TagIndexData, specHash: string): Buffer {
  const steps = layoutSteps(data, specHash, stepEvery(Infinity), false);
  let r = steps.next();
  while (!r.done) r = steps.next();
  const out = Buffer.allocUnsafe(r.value.size);
  let at = 0;
  for (const x of r.value.stream())
    if (x) {
      out.set(x, at);
      at += x.length;
    }
  return out;
}

const BROTLI_PARAMS = (sizeHint: number) => ({
  [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
  [zlib.constants.BROTLI_PARAM_LGWIN]: zlib.constants.BROTLI_DEFAULT_WINDOW,
  [zlib.constants.BROTLI_PARAM_SIZE_HINT]: sizeHint,
});

/**
 * A brotli stream at fixed parameters, written in order and collected. Both encoders go through it;
 * their tests pin that they give the same bytes.
 */
function brotliWriter(sizeHint: number) {
  const z = zlib.createBrotliCompress({ params: BROTLI_PARAMS(sizeHint) });
  const out: Buffer[] = [];
  z.on('data', (d: Buffer) => out.push(d));
  // Every stream error is kept here and rethrown by the next write or the end: an 'error' with no
  // listener would throw out of the process, and a failure while nobody awaits must not go unseen.
  let failure: unknown = null;
  z.on('error', (e) => (failure ??= e));
  const ended = once(z, 'end');
  ended.catch(() => undefined);
  return {
    async write(bytes: Uint8Array) {
      if (failure) throw failure;
      if (!z.write(bytes)) await once(z, 'drain');
    },
    async end() {
      if (failure) throw failure;
      z.end();
      await ended;
      return Buffer.concat(out);
    },
    destroy: () => z.destroy(),
  };
}

const STREAM_CHUNK = 1 << 16;

/** Packed bytes through brotli in `STREAM_CHUNK` writes; no size cap (see `encodeTagIndex`). */
export async function compressTagIndex(raw: Uint8Array): Promise<Buffer> {
  const z = brotliWriter(raw.length);
  for (let o = 0; o < raw.length; o += STREAM_CHUNK)
    await z.write(raw.subarray(o, Math.min(raw.length, o + STREAM_CHUNK)));
  return z.end();
}

function capped(payload: Buffer): Buffer {
  if (payload.length > TAG_INDEX_MAX_PAYLOAD_BYTES)
    throw new Error(
      `tag index payload ${payload.length} bytes exceeds ${TAG_INDEX_MAX_PAYLOAD_BYTES}`
    );
  return payload;
}

export async function encodeTagIndex(data: TagIndexData, specHash: string): Promise<Buffer> {
  return capped(await compressTagIndex(packTagIndex(data, specHash)));
}

/**
 * `encodeTagIndex`'s bytes, packed straight into brotli as they are produced, so the packed bytes are
 * never held whole, pausing every `every` units of work to await `pause` (give it a `loopYielder`).
 * With `consume`, `data`'s postings arrays are emptied as they are packed: pass it only an index
 * nothing else will read.
 */
export async function encodeTagIndexCooperative(
  data: TagIndexData,
  specHash: string,
  pause: () => Promise<void>,
  opts: { every?: number; consume?: boolean } = {}
): Promise<Buffer> {
  const L = await layoutOf(
    layoutSteps(data, specHash, stepEvery(opts.every ?? PACK_STEP_WORK), opts.consume ?? false),
    pause
  );
  const z = brotliWriter(L.size);
  try {
    for (const x of L.stream()) {
      if (x) await z.write(x);
      else await pause();
    }
  } catch (e) {
    z.destroy();
    throw e;
  }
  return capped(await z.end());
}

/** The scorer's index over built or decoded arrays: `validateTagIndexData`, then `assembleTagIndex`. */
export function tagIndexFromData(data: TagIndexData): TagIndex {
  validateTagIndexData(data);
  return assembleTagIndex(data);
}

/** `./payload-decode`'s validation against the build's fit bound (`tagFitBound()`) unless given. */
export function validateTagIndexData(data: TagIndexData, fitBound = tagFitBound()): void {
  validateTagIndexDataWith(data, fitBound);
}

/**
 * Decompress, unpack and validate, without building the scorer's maps, against this module's caps
 * and the build's fit bound unless given (see `./payload-decode`).
 */
export async function decodeTagIndexData(
  payload: Uint8Array,
  caps: TagIndexDecodeCaps = TAG_INDEX_DECODE_CAPS,
  fitBound = tagFitBound()
): Promise<{ data: TagIndexData; vocabVersion: string; specHash: string }> {
  return decodeTagIndexDataWith(payload, caps, fitBound);
}

/**
 * Decompress, unpack, validate and assemble. Does NOT compare the spec hash with the running code's,
 * or the vocabulary version with the frozen one: the caller must.
 */
export async function decodeTagIndex(payload: Uint8Array): Promise<DecodedTagIndex> {
  const { data, vocabVersion, specHash } = await decodeTagIndexData(payload);
  // A whole event-loop turn (timers and I/O, which a microtask or setImmediate would skip) between
  // validating and assembling; `decodeTagIndexData` turns between unpacking and validating.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return { index: assembleTagIndex(data), vocabVersion, specHash };
}

/** `decodeTagIndex` after decompression: the part that runs on the event loop. */
export function unpackTagIndex(raw: Uint8Array): DecodedTagIndex {
  const { data, specHash } = unpackTagIndexData(raw);
  return { index: tagIndexFromData(data), vocabVersion: data.vocabVersion, specHash };
}
