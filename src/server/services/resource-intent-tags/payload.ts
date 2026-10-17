import { promisify } from 'util';
import zlib from 'zlib';
import { Packr } from 'msgpackr';
import type { SparseByKey, TagIndexData, TagIndexKindData } from './build';
import { tagFitBound } from './build';
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
const packr = new Packr({ useRecords: false, mapsAsObjects: true });
const brotliCompress = promisify(zlib.brotliCompress);
/** Little-endian bytes, byte plane by byte plane: every element's byte 0, then every byte 1, … */
function shuffle(a: Wide): Buffer {
  const size = a.BYTES_PER_ELEMENT;
  const n = a.length;
  const le = new Uint8Array(n * size);
  const dv = new DataView(le.buffer);
  if (a instanceof Uint16Array) for (let i = 0; i < n; i++) dv.setUint16(i * 2, a[i], true);
  else if (a instanceof Uint32Array) for (let i = 0; i < n; i++) dv.setUint32(i * 4, a[i], true);
  else if (a instanceof Float32Array) for (let i = 0; i < n; i++) dv.setFloat32(i * 4, a[i], true);
  else for (let i = 0; i < n; i++) dv.setFloat64(i * 8, a[i], true);
  const out = Buffer.allocUnsafe(n * size);
  for (let b = 0; b < size; b++) for (let i = 0; i < n; i++) out[b * n + i] = le[i * size + b];
  return out;
}

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

function encodeSparse(s: SparseByKey, integer: boolean) {
  if (integer)
    for (const v of s.value)
      if (!Number.isInteger(v) || v < 0 || v > 0xffffffff)
        throw new Error(`tag index: count ${v} is not a uint32`);
  return {
    keys: shuffle(deltas(single(s.keys.length), s.keys)),
    len: shuffle(lengths(s.ptr)),
    resource: shuffle(deltas(s.ptr, s.resource)),
    value: shuffle(integer ? Uint32Array.from(s.value) : Float32Array.from(s.value)),
  };
}

function encodeKind(k: TagIndexKindData) {
  const { ptr, resource, c, fit } = k.postings;
  const present = new Uint8Array(Math.ceil(fit.length / 8));
  let nFits = 0;
  for (const v of fit) if (!Number.isNaN(v)) nFits++;
  const fits = new Float32Array(nFits);
  let j = 0;
  const cInt = new Uint16Array(c.length);
  for (let i = 0; i < c.length; i++) {
    const scaled = Math.round(c[i] * C_SCALE);
    if (!(scaled >= 0 && scaled <= C_SCALE) || Math.abs(scaled - c[i] * C_SCALE) > 1e-6)
      throw new Error(
        `tag index: content score ${c[i]} is not a multiple of 1/${C_SCALE} in [0, 1]`
      );
    cInt[i] = scaled;
    if (!Number.isNaN(fit[i])) {
      present[i >> 3] |= 1 << (i & 7);
      fits[j++] = fit[i];
    }
  }
  return {
    modelIds: shuffle(deltas(single(k.modelIds.length), k.modelIds)),
    fit: shuffle(Float32Array.from(k.fit)),
    ecosystemLen: shuffle(lengths(k.ecosystemPtr)),
    ecosystemIds: shuffle(deltas(k.ecosystemPtr, k.ecosystemIds)),
    postings: {
      len: shuffle(lengths(ptr)),
      resource: shuffle(deltas(ptr, resource)),
      c: shuffle(cInt),
      fitPresent: Buffer.from(present),
      fit: shuffle(fits),
    },
    ecosystemUsers: encodeSparse(k.ecosystemUsers, true),
    userByTag: encodeSparse(k.userByTag, false),
    userByEcosystem: encodeSparse(k.userByEcosystem, false),
  };
}

/** Uncompressed bytes: what the spec hash fingerprints. */
export function packTagIndex(data: TagIndexData, specHash: string): Buffer {
  const v = data.vocabulary;
  const nearPtr = new Uint32Array(v.length + 1);
  v.forEach((t, i) => (nearPtr[i + 1] = nearPtr[i] + t.near.length));
  const near = Uint32Array.from(v.flatMap((t) => t.near));
  const tc = data.tagEcosystemCounts;
  return packr.pack({
    format: TAG_INDEX_PAYLOAD_FORMAT,
    vocabVersion: data.vocabVersion,
    specHash,
    rowsWithEcosystem: data.rowsWithEcosystem,
    vocabulary: {
      keys: v.map((t) => t.key),
      users: shuffle(Uint32Array.from(v, (t) => t.users)),
      idf: shuffle(Float64Array.from(v, (t) => t.idf)),
      explicit: Buffer.from(Uint8Array.from(v, (t) => (t.explicit ? 1 : 0))),
      nearLen: shuffle(lengths(nearPtr)),
      near: shuffle(deltas(nearPtr, near)),
    },
    ecosystems: {
      names: data.ecosystems.map((e) => e.name),
      users: shuffle(Uint32Array.from(data.ecosystems, (e) => e.users)),
      observations: shuffle(Uint32Array.from(data.ecosystems, (e) => e.observations)),
    },
    tagEcosystemCounts: {
      len: shuffle(lengths(tc.ptr)),
      ecosystem: shuffle(deltas(tc.ptr, tc.ecosystem)),
      count: shuffle(tc.count),
    },
    kinds: { addon: encodeKind(data.kinds.addon), checkpoint: encodeKind(data.kinds.checkpoint) },
  });
}

/** Brotli at fixed parameters; no size cap (see `encodeTagIndex`). */
export async function compressTagIndex(raw: Buffer): Promise<Buffer> {
  return brotliCompress(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_LGWIN]: zlib.constants.BROTLI_DEFAULT_WINDOW,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
}

export async function encodeTagIndex(data: TagIndexData, specHash: string): Promise<Buffer> {
  const payload = await compressTagIndex(packTagIndex(data, specHash));
  if (payload.length > TAG_INDEX_MAX_PAYLOAD_BYTES)
    throw new Error(
      `tag index payload ${payload.length} bytes exceeds ${TAG_INDEX_MAX_PAYLOAD_BYTES}`
    );
  return payload;
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
 * Decompress, unpack and validate. Does NOT compare the spec hash with the running code's, or the
 * vocabulary version with the frozen one: the caller must.
 */
export async function decodeTagIndex(payload: Uint8Array): Promise<DecodedTagIndex> {
  const { data, vocabVersion, specHash } = await decodeTagIndexData(payload);
  return { index: assembleTagIndex(data), vocabVersion, specHash };
}

/** `decodeTagIndex` after decompression: the part that runs on the event loop. */
export function unpackTagIndex(raw: Uint8Array): DecodedTagIndex {
  const { data, specHash } = unpackTagIndexData(raw);
  return { index: tagIndexFromData(data), vocabVersion: data.vocabVersion, specHash };
}
