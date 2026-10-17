import { endianness } from 'os';
import { promisify } from 'util';
import zlib from 'zlib';
import { Packr } from 'msgpackr';
import type { SparseByKey, TagIndexData, TagIndexKindData, TagResourceKind } from './build';
import { compareCodePoints } from './extract';
import type {
  FloatArray,
  ResourceValues,
  TagIndex,
  TagIndexKind,
  TagVocabularyEntry,
} from './score';

/**
 * The content-tag index snapshot: msgpack + brotli, with the vocabulary embedded and its version and
 * the spec hash in the header. Lossless against the build except for float32 values (idf stays
 * float64): content scores, which the build rounds to 4 decimals, travel as exact integers c·10⁴;
 * ascending ids as deltas; CSR pointers as row lengths; a pair fit only where the pair has one, under
 * a presence bitmap; every multi-byte array byte-plane shuffled (for brotli). `tagIndexFromData`
 * refuses any index that breaks a precondition the scorer (`./score`) relies on, decoded or built in
 * memory. Decoding needs a little-endian host.
 */

export const TAG_INDEX_PAYLOAD_FORMAT = 'resource-intent-tags/1';
/** Sized for object storage (design P6c): the real index measured 80.5 MiB compressed. */
export const TAG_INDEX_MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;
/**
 * Caps brotli's output; keep it well above a real build's msgpack size
 * (docs/resource-intent-primitive.md, Snapshot).
 */
const TAG_INDEX_MAX_INFLATED_BYTES = 512 * 1024 * 1024;
const BROTLI_QUALITY = 9;
const C_SCALE = 10_000;

const packr = new Packr({ useRecords: false, mapsAsObjects: true });
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

function fail(what: string): never {
  throw new Error(`tag index payload invalid: ${what}`);
}

type Wide = Uint16Array | Uint32Array | Float32Array | Float64Array;
type WideCtor = { new (n: number): Wide; BYTES_PER_ELEMENT: number };

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

const LITTLE_ENDIAN = endianness() === 'LE';
const viewOf = (le: Uint8Array, Ctor: WideCtor) =>
  new (Ctor as unknown as new (b: ArrayBuffer) => Wide)(le.buffer as ArrayBuffer);

function unshuffle<T extends Wide>(bin: unknown, Ctor: WideCtor, what: string): T {
  if (!(bin instanceof Uint8Array)) fail(`${what} is not binary`);
  const b = bin as Uint8Array;
  const size = Ctor.BYTES_PER_ELEMENT;
  if (b.length % size) fail(`${what} length`);
  const n = b.length / size;
  if (!LITTLE_ENDIAN) throw new Error('tag index: decoding needs a little-endian host');
  const le = new Uint8Array(b.length);
  for (let k = 0; k < size; k++) for (let i = 0; i < n; i++) le[i * size + k] = b[k * n + i];
  // `le` is a fresh, aligned buffer, so it already is the array.
  return viewOf(le, Ctor) as T;
}

const u32 = (b: unknown, what: string) => unshuffle<Uint32Array>(b, Uint32Array, what);

/** A CSR pointer as its row lengths. */
const lengths = (ptr: Uint32Array) =>
  Uint32Array.from({ length: ptr.length - 1 }, (_, i) => ptr[i + 1] - ptr[i]);

function ptrOf(len: Uint32Array, what: string): Uint32Array {
  const ptr = new Uint32Array(len.length + 1);
  let t = 0;
  for (let i = 0; i < len.length; i++) {
    t += len[i];
    if (t > 0xffffffff) fail(`${what} pointer overflow`);
    ptr[i + 1] = t;
  }
  return ptr;
}

/** Ids as differences from the previous id of the same row (the first of a row as is). */
function deltas(ptr: Uint32Array, ids: Uint32Array): Uint32Array {
  const out = new Uint32Array(ids.length);
  for (let i = 0; i + 1 < ptr.length; i++)
    for (let k = ptr[i]; k < ptr[i + 1]; k++) out[k] = k > ptr[i] ? ids[k] - ids[k - 1] : ids[k];
  return out;
}

function undeltas(ptr: Uint32Array, d: Uint32Array, what: string): Uint32Array {
  if (ptr[ptr.length - 1] !== d.length) fail(`${what} pointer bounds`);
  const out = new Uint32Array(d.length);
  for (let i = 0; i + 1 < ptr.length; i++) {
    let v = 0;
    for (let k = ptr[i]; k < ptr[i + 1]; k++) {
      v = k > ptr[i] ? v + d[k] : d[k];
      if (v > 0xffffffff) fail(`${what} id overflow`);
      out[k] = v;
    }
  }
  return out;
}

const single = (n: number) => Uint32Array.of(0, n);

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

function decodeSparse(raw: Record<string, unknown>, what: string, integer: boolean): SparseByKey {
  const keyDeltas = u32(raw.keys, `${what} keys`);
  const keys = undeltas(single(keyDeltas.length), keyDeltas, what);
  const ptr = ptrOf(u32(raw.len, `${what} lengths`), what);
  return {
    keys,
    ptr,
    resource: undeltas(ptr, u32(raw.resource, `${what} resource`), what),
    value: integer
      ? new Float32Array(u32(raw.value, `${what} value`))
      : unshuffle<Float32Array>(raw.value, Float32Array, `${what} value`),
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

function decodeKind(raw: Record<string, unknown>, kind: string): TagIndexKindData {
  const what = (x: string) => `${kind} ${x}`;
  const idDeltas = u32(raw.modelIds, what('modelIds'));
  const modelIds = undeltas(single(idDeltas.length), idDeltas, what('modelIds'));
  const ecosystemPtr = ptrOf(u32(raw.ecosystemLen, what('ecosystem lengths')), what('ecosystems'));
  const p = raw.postings as Record<string, unknown>;
  const ptr = ptrOf(u32(p.len, what('postings lengths')), what('postings'));
  const resource = undeltas(ptr, u32(p.resource, what('postings resource')), what('postings'));
  const cInt = unshuffle<Uint16Array>(p.c, Uint16Array, what('postings c'));
  if (cInt.length !== resource.length) fail(what('postings arrays'));
  const c = new Float32Array(cInt.length);
  for (let i = 0; i < c.length; i++) {
    if (cInt[i] > C_SCALE) fail(what('postings c above 1'));
    c[i] = cInt[i] / C_SCALE;
  }
  const present = p.fitPresent;
  if (!(present instanceof Uint8Array) || present.length !== Math.ceil(c.length / 8))
    fail(what('postings fit presence'));
  const fits = unshuffle<Float32Array>(p.fit, Float32Array, what('postings fit'));
  const fit = new Float32Array(c.length).fill(NaN);
  let j = 0;
  for (let i = 0; i < c.length; i++)
    if ((present as Uint8Array)[i >> 3] & (1 << (i & 7))) {
      if (j >= fits.length) fail(what('postings fit presence'));
      fit[i] = fits[j++];
    }
  if (j !== fits.length) fail(what('postings fit presence'));
  return {
    modelIds,
    fit: unshuffle<Float32Array>(raw.fit, Float32Array, what('fit')),
    ecosystemPtr,
    ecosystemIds: undeltas(
      ecosystemPtr,
      u32(raw.ecosystemIds, what('ecosystemIds')),
      what('ecosystems')
    ),
    postings: { ptr, resource, c, fit },
    ecosystemUsers: decodeSparse(
      raw.ecosystemUsers as Record<string, unknown>,
      what('ecosystemUsers'),
      true
    ),
    userByTag: decodeSparse(raw.userByTag as Record<string, unknown>, what('userByTag'), false),
    userByEcosystem: decodeSparse(
      raw.userByEcosystem as Record<string, unknown>,
      what('userByEcosystem'),
      false
    ),
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

export async function decompressTagIndex(payload: Uint8Array): Promise<Buffer> {
  return brotliDecompress(payload, { maxOutputLength: TAG_INDEX_MAX_INFLATED_BYTES });
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The arrays of a packed snapshot, checked for format and shape; `tagIndexFromData` validates the
 * index.
 */
export function unpackTagIndexData(raw: Uint8Array): {
  data: TagIndexData;
  specHash: string;
} {
  const doc = packr.unpack(raw) as Record<string, unknown>;
  if (!doc || doc.format !== TAG_INDEX_PAYLOAD_FORMAT) fail('unknown format');
  const specHash = doc.specHash as string;
  if (typeof specHash !== 'string' || !HEX64.test(specHash)) fail('specHash');
  const rv = doc.vocabulary as Record<string, unknown>;
  const keys = rv.keys as string[];
  if (!Array.isArray(keys)) fail('vocabulary keys');
  const idf = unshuffle<Float64Array>(rv.idf, Float64Array, 'idf');
  const users = u32(rv.users, 'vocabulary users');
  const explicit = rv.explicit;
  if (!(explicit instanceof Uint8Array)) fail('explicit is not binary');
  const nearPtr = ptrOf(u32(rv.nearLen, 'near lengths'), 'near');
  const near = undeltas(nearPtr, u32(rv.near, 'near'), 'near');
  if (idf.length !== keys.length || users.length !== keys.length || explicit.length !== keys.length)
    fail('vocabulary arrays');
  if (nearPtr.length !== keys.length + 1) fail('near pointer length');
  const re = doc.ecosystems as Record<string, unknown>;
  const names = re.names as string[];
  if (!Array.isArray(names)) fail('ecosystem names');
  const ecoUsers = u32(re.users, 'ecosystem users');
  const ecoObs = u32(re.observations, 'ecosystem observations');
  if (ecoUsers.length !== names.length || ecoObs.length !== names.length) fail('ecosystem arrays');
  const rc = doc.tagEcosystemCounts as Record<string, unknown>;
  const cPtr = ptrOf(u32(rc.len, 'tagEcosystemCounts lengths'), 'tagEcosystemCounts');
  const rk = doc.kinds as Record<TagResourceKind, Record<string, unknown>>;
  const data: TagIndexData = {
    vocabVersion: doc.vocabVersion as string,
    rowsWithEcosystem: doc.rowsWithEcosystem as number,
    vocabulary: keys.map((key, i) => ({
      key,
      idf: idf[i],
      users: users[i],
      explicit:
        (explicit as Uint8Array)[i] === 1
          ? true
          : (explicit as Uint8Array)[i] === 0
          ? false
          : fail('explicit flag'),
      near: Array.from(near.subarray(nearPtr[i], nearPtr[i + 1])),
    })),
    ecosystems: names.map((name, i) => ({ name, users: ecoUsers[i], observations: ecoObs[i] })),
    tagEcosystemCounts: {
      ptr: cPtr,
      ecosystem: undeltas(
        cPtr,
        u32(rc.ecosystem, 'tagEcosystemCounts ecosystem'),
        'tagEcosystemCounts'
      ),
      count: u32(rc.count, 'tagEcosystemCounts count'),
    },
    kinds: {
      addon: decodeKind(rk.addon, 'addon'),
      checkpoint: decodeKind(rk.checkpoint, 'checkpoint'),
    },
  };
  return { data, specHash };
}

/** A CSR pointer over `rows` rows into `length` entries: starts at 0, never decreases, ends at length. */
function checkPtr(ptr: Uint32Array, rows: number, length: number, what: string) {
  if (ptr.length !== rows + 1) fail(`${what} pointer length`);
  if (ptr[0] !== 0 || ptr[rows] !== length) fail(`${what} pointer bounds`);
  for (let i = 0; i < rows; i++) if (ptr[i + 1] < ptr[i]) fail(`${what} pointer order`);
}

/** Within each row, ids strictly ascending and below `limit`. */
function checkIds(ptr: Uint32Array, ids: Uint32Array, limit: number, what: string) {
  for (let i = 0; i + 1 < ptr.length; i++)
    for (let k = ptr[i]; k < ptr[i + 1]; k++) {
      if (ids[k] >= limit) fail(`${what} id out of range`);
      if (k > ptr[i] && ids[k] <= ids[k - 1]) fail(`${what} id order`);
    }
}

const finite = (v: number) => Number.isFinite(v);
const positive = (v: number) => Number.isFinite(v) && v > 0;

function sparseIndex(
  s: SparseByKey,
  keyLimit: number,
  n: number,
  what: string,
  valueOk: (v: number) => boolean
): Map<number, ResourceValues> {
  if (s.value.length !== s.resource.length) fail(`${what} arrays`);
  checkIds(single(s.keys.length), s.keys, keyLimit, `${what} key`);
  checkPtr(s.ptr, s.keys.length, s.resource.length, what);
  checkIds(s.ptr, s.resource, n, `${what} resource`);
  for (const v of s.value) if (!valueOk(v)) fail(`${what} value`);
  const out = new Map<number, ResourceValues>();
  for (let i = 0; i < s.keys.length; i++)
    out.set(s.keys[i], {
      resource: s.resource.subarray(s.ptr[i], s.ptr[i + 1]),
      value: s.value.subarray(s.ptr[i], s.ptr[i + 1]) as FloatArray,
    });
  return out;
}

function kindIndex(k: TagIndexKindData, V: number, E: number, kind: string): TagIndexKind {
  const what = (x: string) => `${kind} ${x}`;
  const ids = k.modelIds;
  const n = ids.length;
  for (let i = 1; i < n; i++) if (ids[i] <= ids[i - 1]) fail(what('model ids not ascending'));
  if (k.fit.length !== n) fail(what('fit length'));
  for (const v of k.fit) if (!finite(v)) fail(what('fit not finite'));
  checkPtr(k.ecosystemPtr, n, k.ecosystemIds.length, what('ecosystems'));
  checkIds(k.ecosystemPtr, k.ecosystemIds, E, what('ecosystem'));
  const { ptr, resource, c, fit } = k.postings;
  if (c.length !== resource.length || fit.length !== resource.length) fail(what('postings arrays'));
  checkPtr(ptr, V, resource.length, what('postings'));
  checkIds(ptr, resource, n, what('postings resource'));
  for (let i = 0; i < c.length; i++) {
    if (!(c[i] >= 0 && c[i] <= 1)) fail(what('postings c'));
    if (Number.isNaN(fit[i])) {
      if (!(c[i] > 0)) fail(what('postings entry with neither c nor fit'));
    } else if (!finite(fit[i])) fail(what('postings fit not finite'));
  }
  return {
    modelIds: Array.from(ids),
    fit: k.fit,
    ecosystems: Array.from({ length: n }, (_, i) =>
      Array.from(k.ecosystemIds.subarray(k.ecosystemPtr[i], k.ecosystemPtr[i + 1]))
    ),
    postings: { ptr, resource, c, fit },
    ecosystemUsers: sparseIndex(
      k.ecosystemUsers,
      E,
      n,
      what('ecosystemUsers'),
      (v) => Number.isInteger(v) && v > 0
    ),
    userByTag: sparseIndex(k.userByTag, V, n, what('userByTag'), positive),
    userByEcosystem: sparseIndex(k.userByEcosystem, E, n, what('userByEcosystem'), positive),
  };
}

/**
 * The scorer's index over built or decoded arrays, refused unless every precondition holds: keys and
 * names in code-point order, model ids strictly ascending, CSR pointers of the right length and
 * monotone, ids in range and ascending within a row, values finite, content scores in [0, 1], and the
 * ecosystems' observations summing to the build's count of rows with an ecosystem, so none (including
 * those below the resolver's user floor) was left out.
 */
export function tagIndexFromData(data: TagIndexData): TagIndex {
  if (typeof data.vocabVersion !== 'string' || !HEX64.test(data.vocabVersion)) fail('vocabVersion');
  const keys = data.vocabulary.map((t) => t.key);
  const V = keys.length;
  if (!V) fail('vocabulary keys');
  for (let i = 0; i < V; i++) {
    if (typeof keys[i] !== 'string' || !keys[i]) fail('vocabulary key');
    if (i && compareCodePoints(keys[i - 1], keys[i]) >= 0) fail('vocabulary key order');
  }
  const vocabulary: TagVocabularyEntry[] = data.vocabulary.map((t, i) => {
    if (!finite(t.idf)) fail('idf not finite');
    for (let k = 0; k < t.near.length; k++) {
      const j = t.near[k];
      if (!Number.isInteger(j) || j < 0 || j >= V) fail('near id out of range');
      if (j === i) fail('near holds its own tag');
      if (k && j <= t.near[k - 1]) fail('near id order');
    }
    return { key: t.key, idf: t.idf, explicit: t.explicit, near: t.near };
  });

  const E = data.ecosystems.length;
  data.ecosystems.forEach((e, i) => {
    if (typeof e.name !== 'string' || !e.name) fail('ecosystem name');
    if (i && compareCodePoints(data.ecosystems[i - 1].name, e.name) >= 0)
      fail('ecosystem name order');
  });
  if (data.ecosystems.reduce((s, e) => s + e.observations, 0) !== data.rowsWithEcosystem)
    fail('ecosystem observations do not sum to the rows with an ecosystem');

  const tc = data.tagEcosystemCounts;
  if (tc.count.length !== tc.ecosystem.length) fail('tagEcosystemCounts arrays');
  checkPtr(tc.ptr, V, tc.ecosystem.length, 'tagEcosystemCounts');
  checkIds(tc.ptr, tc.ecosystem, E, 'tagEcosystemCounts ecosystem');
  const tagEcosystemCounts = new Map<number, Map<number, number>>();
  for (let t = 0; t < V; t++) {
    if (tc.ptr[t + 1] === tc.ptr[t]) continue;
    const m = new Map<number, number>();
    for (let k = tc.ptr[t]; k < tc.ptr[t + 1]; k++) {
      if (tc.count[k] < 1 || tc.count[k] > data.ecosystems[tc.ecosystem[k]].observations)
        fail('tagEcosystemCounts count');
      m.set(tc.ecosystem[k], tc.count[k]);
    }
    tagEcosystemCounts.set(t, m);
  }

  return {
    vocabulary,
    idByKey: new Map(keys.map((k, i) => [k, i])),
    ecosystems: data.ecosystems.map((e) => ({ ...e })),
    tagEcosystemCounts,
    kinds: {
      addon: kindIndex(data.kinds.addon, V, E, 'addon'),
      checkpoint: kindIndex(data.kinds.checkpoint, V, E, 'checkpoint'),
    },
  };
}

export type DecodedTagIndex = {
  index: TagIndex;
  vocabVersion: string;
  specHash: string;
};

/**
 * Decompress, unpack and validate. Does NOT compare the spec hash with the running code's, or the
 * vocabulary version with the frozen one: the caller must.
 */
export async function decodeTagIndex(payload: Uint8Array): Promise<DecodedTagIndex> {
  if (payload.length > TAG_INDEX_MAX_PAYLOAD_BYTES)
    throw new Error(
      `tag index payload ${payload.length} bytes exceeds ${TAG_INDEX_MAX_PAYLOAD_BYTES}`
    );
  return unpackTagIndex(await decompressTagIndex(payload));
}

/** `decodeTagIndex` after decompression: the part that runs on the event loop. */
export function unpackTagIndex(raw: Uint8Array): DecodedTagIndex {
  const { data, specHash } = unpackTagIndexData(raw);
  return { index: tagIndexFromData(data), vocabVersion: data.vocabVersion, specHash };
}
