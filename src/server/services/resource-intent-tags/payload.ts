import { promisify } from 'util';
import zlib from 'zlib';
import { Packr } from 'msgpackr';
import type { SparseByKey, TagIndexData, TagIndexKindData, TagResourceKind } from './build';
import { compareCodePoints } from './extract';
import type { ResourceValues, TagIndex, TagIndexKind, TagVocabularyEntry } from './score';

/**
 * The content-tag index snapshot: msgpack + brotli of typed arrays (little-endian `bin` fields), with
 * the vocabulary embedded and its version and the spec hash in the header. Per-resource and per-pair
 * values are float32; idf stays float64, as the vocabulary row carries it. The decoder refuses any
 * payload that breaks a precondition the scorer (`./score`) relies on.
 */

export const TAG_INDEX_PAYLOAD_FORMAT = 'resource-intent-tags/1';
export const TAG_INDEX_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const TAG_INDEX_MAX_INFLATED_BYTES = 1024 * 1024 * 1024;
const BROTLI_QUALITY = 9;

const packr = new Packr({ useRecords: false, mapsAsObjects: true });
const brotliCompress = promisify(zlib.brotliCompress);
const brotliDecompress = promisify(zlib.brotliDecompress);

type Typed = Uint8Array | Uint32Array | Float32Array | Float64Array;
type TypedCtor = { new (n: number): Typed; BYTES_PER_ELEMENT: number };

function le(a: Typed): Buffer {
  const size = a.BYTES_PER_ELEMENT;
  const out = Buffer.allocUnsafe(a.length * size);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (a instanceof Uint8Array) out.set(a);
  else if (a instanceof Uint32Array)
    for (let i = 0; i < a.length; i++) dv.setUint32(i * 4, a[i], true);
  else if (a instanceof Float32Array)
    for (let i = 0; i < a.length; i++) dv.setFloat32(i * 4, a[i], true);
  else for (let i = 0; i < a.length; i++) dv.setFloat64(i * 8, a[i], true);
  return out;
}

function fromLe<T extends Typed>(b: unknown, Ctor: TypedCtor, what: string): T {
  if (!(b instanceof Uint8Array)) fail(`${what} is not binary`);
  const bin = b as Uint8Array;
  const size = Ctor.BYTES_PER_ELEMENT;
  if (bin.length % size) fail(`${what} length`);
  const out = new Ctor(bin.length / size) as T;
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  if (out instanceof Uint8Array) out.set(bin);
  else if (out instanceof Uint32Array)
    for (let i = 0; i < out.length; i++) out[i] = dv.getUint32(i * 4, true);
  else if (out instanceof Float32Array)
    for (let i = 0; i < out.length; i++) out[i] = dv.getFloat32(i * 4, true);
  else for (let i = 0; i < out.length; i++) out[i] = dv.getFloat64(i * 8, true);
  return out;
}

const f32 = (a: Float64Array) => le(Float32Array.from(a));

function encodeSparse(s: SparseByKey) {
  return { keys: le(s.keys), ptr: le(s.ptr), resource: le(s.resource), value: f32(s.value) };
}

function encodeKind(k: TagIndexKindData) {
  return {
    modelIds: le(k.modelIds),
    fit: f32(k.fit),
    ecosystemPtr: le(k.ecosystemPtr),
    ecosystemIds: le(k.ecosystemIds),
    postings: {
      ptr: le(k.postings.ptr),
      resource: le(k.postings.resource),
      c: f32(k.postings.c),
      fit: f32(k.postings.fit),
    },
    ecosystemUsers: encodeSparse(k.ecosystemUsers),
    userByTag: encodeSparse(k.userByTag),
    userByEcosystem: encodeSparse(k.userByEcosystem),
  };
}

/** The msgpack bytes before compression; `encodeTagIndex` compresses them. */
export function packTagIndex(data: TagIndexData, specHash: string): Buffer {
  const v = data.vocabulary;
  const nearPtr = new Uint32Array(v.length + 1);
  v.forEach((t, i) => (nearPtr[i + 1] = nearPtr[i] + t.near.length));
  return packr.pack({
    format: TAG_INDEX_PAYLOAD_FORMAT,
    vocabVersion: data.vocabVersion,
    specHash,
    vocabulary: {
      keys: v.map((t) => t.key),
      users: le(Uint32Array.from(v, (t) => t.users)),
      idf: le(Float64Array.from(v, (t) => t.idf)),
      explicit: le(Uint8Array.from(v, (t) => (t.explicit ? 1 : 0))),
      nearPtr: le(nearPtr),
      near: le(Uint32Array.from(v.flatMap((t) => t.near))),
    },
    ecosystems: {
      names: data.ecosystems.map((e) => e.name),
      users: le(Uint32Array.from(data.ecosystems, (e) => e.users)),
      observations: le(Uint32Array.from(data.ecosystems, (e) => e.observations)),
    },
    rowsWithEcosystem: data.rowsWithEcosystem,
    tagEcosystemCounts: {
      ptr: le(data.tagEcosystemCounts.ptr),
      ecosystem: le(data.tagEcosystemCounts.ecosystem),
      count: le(data.tagEcosystemCounts.count),
    },
    kinds: { addon: encodeKind(data.kinds.addon), checkpoint: encodeKind(data.kinds.checkpoint) },
  });
}

/** Fixed parameters: changing any of them changes the payload bytes. */
export async function encodeTagIndex(data: TagIndexData, specHash: string): Promise<Buffer> {
  const raw = packTagIndex(data, specHash);
  const payload = await brotliCompress(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
      [zlib.constants.BROTLI_PARAM_LGWIN]: zlib.constants.BROTLI_DEFAULT_WINDOW,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
    },
  });
  if (payload.length > TAG_INDEX_MAX_PAYLOAD_BYTES)
    throw new Error(
      `tag index payload ${payload.length} bytes exceeds ${TAG_INDEX_MAX_PAYLOAD_BYTES}`
    );
  return payload;
}

function fail(what: string): never {
  throw new Error(`tag index payload invalid: ${what}`);
}

const HEX64 = /^[0-9a-f]{64}$/;

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

function decodeSparse(
  raw: Record<string, unknown>,
  keyLimit: number,
  n: number,
  what: string,
  valueOk: (v: number) => boolean
): Map<number, ResourceValues> {
  const keys = fromLe<Uint32Array>(raw.keys, Uint32Array, `${what} keys`);
  const ptr = fromLe<Uint32Array>(raw.ptr, Uint32Array, `${what} ptr`);
  const resource = fromLe<Uint32Array>(raw.resource, Uint32Array, `${what} resource`);
  const value = fromLe<Float32Array>(raw.value, Float32Array, `${what} value`);
  if (value.length !== resource.length) fail(`${what} arrays`);
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] >= keyLimit) fail(`${what} key out of range`);
    if (i && keys[i] <= keys[i - 1]) fail(`${what} key order`);
  }
  checkPtr(ptr, keys.length, resource.length, what);
  checkIds(ptr, resource, n, `${what} resource`);
  for (const v of value) if (!valueOk(v)) fail(`${what} value`);
  const out = new Map<number, ResourceValues>();
  for (let i = 0; i < keys.length; i++)
    out.set(keys[i], {
      resource: resource.subarray(ptr[i], ptr[i + 1]),
      value: value.subarray(ptr[i], ptr[i + 1]),
    });
  return out;
}

const finite = (v: number) => Number.isFinite(v);
const positive = (v: number) => Number.isFinite(v) && v > 0;

function decodeKind(
  raw: Record<string, unknown>,
  V: number,
  E: number,
  kind: string
): TagIndexKind {
  const what = (x: string) => `${kind} ${x}`;
  const ids = fromLe<Uint32Array>(raw.modelIds, Uint32Array, what('modelIds'));
  const n = ids.length;
  for (let i = 1; i < n; i++) if (ids[i] <= ids[i - 1]) fail(what('model ids not ascending'));
  const fit = fromLe<Float32Array>(raw.fit, Float32Array, what('fit'));
  if (fit.length !== n) fail(what('fit length'));
  for (const v of fit) if (!finite(v)) fail(what('fit not finite'));

  const ecoPtr = fromLe<Uint32Array>(raw.ecosystemPtr, Uint32Array, what('ecosystemPtr'));
  const ecoIds = fromLe<Uint32Array>(raw.ecosystemIds, Uint32Array, what('ecosystemIds'));
  checkPtr(ecoPtr, n, ecoIds.length, what('ecosystems'));
  checkIds(ecoPtr, ecoIds, E, what('ecosystem'));

  const p = raw.postings as Record<string, unknown>;
  const ptr = fromLe<Uint32Array>(p.ptr, Uint32Array, what('postings ptr'));
  const resource = fromLe<Uint32Array>(p.resource, Uint32Array, what('postings resource'));
  const c = fromLe<Float32Array>(p.c, Float32Array, what('postings c'));
  const pfit = fromLe<Float32Array>(p.fit, Float32Array, what('postings fit'));
  if (c.length !== resource.length || pfit.length !== resource.length)
    fail(what('postings arrays'));
  checkPtr(ptr, V, resource.length, what('postings'));
  checkIds(ptr, resource, n, what('postings resource'));
  for (let k = 0; k < c.length; k++) {
    if (!(c[k] >= 0 && c[k] <= 1)) fail(what('postings c'));
    if (Number.isNaN(pfit[k])) {
      if (!(c[k] > 0)) fail(what('postings entry with neither c nor fit'));
    } else if (!finite(pfit[k])) fail(what('postings fit not finite'));
  }

  return {
    modelIds: Array.from(ids),
    fit,
    ecosystems: Array.from({ length: n }, (_, i) =>
      Array.from(ecoIds.subarray(ecoPtr[i], ecoPtr[i + 1]))
    ),
    postings: { ptr, resource, c, fit: pfit },
    ecosystemUsers: decodeSparse(
      raw.ecosystemUsers as Record<string, unknown>,
      E,
      n,
      what('ecosystemUsers'),
      (v) => Number.isInteger(v) && v > 0
    ),
    userByTag: decodeSparse(
      raw.userByTag as Record<string, unknown>,
      V,
      n,
      what('userByTag'),
      positive
    ),
    userByEcosystem: decodeSparse(
      raw.userByEcosystem as Record<string, unknown>,
      E,
      n,
      what('userByEcosystem'),
      positive
    ),
  };
}

export type DecodedTagIndex = {
  index: TagIndex;
  vocabVersion: string;
  specHash: string;
};

/**
 * Decode and validate. Does NOT compare the spec hash with the running code's, or the vocabulary
 * version with the frozen one; its caller does.
 */
export async function decodeTagIndex(payload: Uint8Array): Promise<DecodedTagIndex> {
  if (payload.length > TAG_INDEX_MAX_PAYLOAD_BYTES)
    throw new Error(
      `tag index payload ${payload.length} bytes exceeds ${TAG_INDEX_MAX_PAYLOAD_BYTES}`
    );
  const raw = await brotliDecompress(payload, { maxOutputLength: TAG_INDEX_MAX_INFLATED_BYTES });
  return unpackTagIndex(raw);
}

/** `decodeTagIndex` without the decompression. */
export function unpackTagIndex(raw: Uint8Array): DecodedTagIndex {
  const doc = packr.unpack(raw) as Record<string, unknown>;
  if (!doc || doc.format !== TAG_INDEX_PAYLOAD_FORMAT) fail('unknown format');
  const vocabVersion = doc.vocabVersion as string;
  const specHash = doc.specHash as string;
  if (typeof vocabVersion !== 'string' || !HEX64.test(vocabVersion)) fail('vocabVersion');
  if (typeof specHash !== 'string' || !HEX64.test(specHash)) fail('specHash');

  const rv = doc.vocabulary as Record<string, unknown>;
  const keys = rv.keys as string[];
  if (!Array.isArray(keys) || !keys.length) fail('vocabulary keys');
  const V = keys.length;
  for (let i = 0; i < V; i++) {
    if (typeof keys[i] !== 'string' || !keys[i]) fail('vocabulary key');
    if (i && compareCodePoints(keys[i - 1], keys[i]) >= 0) fail('vocabulary key order');
  }
  const idf = fromLe<Float64Array>(rv.idf, Float64Array, 'idf');
  const explicit = fromLe<Uint8Array>(rv.explicit, Uint8Array, 'explicit');
  const nearPtr = fromLe<Uint32Array>(rv.nearPtr, Uint32Array, 'nearPtr');
  const near = fromLe<Uint32Array>(rv.near, Uint32Array, 'near');
  if (idf.length !== V || explicit.length !== V) fail('vocabulary arrays');
  for (const v of idf) if (!finite(v)) fail('idf not finite');
  for (const v of explicit) if (v > 1) fail('explicit flag');
  checkPtr(nearPtr, V, near.length, 'near');
  checkIds(nearPtr, near, V, 'near');
  const vocabulary: TagVocabularyEntry[] = keys.map((key, i) => {
    const ns = Array.from(near.subarray(nearPtr[i], nearPtr[i + 1]));
    if (ns.includes(i)) fail('near holds its own tag');
    return { key, idf: idf[i], explicit: explicit[i] === 1, near: ns };
  });

  const re = doc.ecosystems as Record<string, unknown>;
  const names = re.names as string[];
  if (!Array.isArray(names)) fail('ecosystem names');
  const E = names.length;
  for (let i = 0; i < E; i++) {
    if (typeof names[i] !== 'string' || !names[i]) fail('ecosystem name');
    if (i && compareCodePoints(names[i - 1], names[i]) >= 0) fail('ecosystem name order');
  }
  const ecoUsers = fromLe<Uint32Array>(re.users, Uint32Array, 'ecosystem users');
  const ecoObs = fromLe<Uint32Array>(re.observations, Uint32Array, 'ecosystem observations');
  if (ecoUsers.length !== E || ecoObs.length !== E) fail('ecosystem arrays');
  // The resolver's totals sum over EVERY ecosystem, so none may be missing: the sum of their
  // observations must equal the build's own count of rows with an ecosystem.
  if (ecoObs.reduce((s, v) => s + v, 0) !== doc.rowsWithEcosystem)
    fail('ecosystem observations do not sum to the rows with an ecosystem');

  const rc = doc.tagEcosystemCounts as Record<string, unknown>;
  const cPtr = fromLe<Uint32Array>(rc.ptr, Uint32Array, 'tagEcosystemCounts ptr');
  const cEco = fromLe<Uint32Array>(rc.ecosystem, Uint32Array, 'tagEcosystemCounts ecosystem');
  const cCount = fromLe<Uint32Array>(rc.count, Uint32Array, 'tagEcosystemCounts count');
  if (cCount.length !== cEco.length) fail('tagEcosystemCounts arrays');
  checkPtr(cPtr, V, cEco.length, 'tagEcosystemCounts');
  checkIds(cPtr, cEco, E, 'tagEcosystemCounts ecosystem');
  const tagEcosystemCounts = new Map<number, Map<number, number>>();
  for (let t = 0; t < V; t++) {
    if (cPtr[t + 1] === cPtr[t]) continue;
    const m = new Map<number, number>();
    for (let k = cPtr[t]; k < cPtr[t + 1]; k++) {
      if (cCount[k] < 1 || cCount[k] > ecoObs[cEco[k]]) fail('tagEcosystemCounts count');
      m.set(cEco[k], cCount[k]);
    }
    tagEcosystemCounts.set(t, m);
  }

  const rk = doc.kinds as Record<TagResourceKind, Record<string, unknown>>;
  const index: TagIndex = {
    vocabulary,
    idByKey: new Map(keys.map((k, i) => [k, i])),
    ecosystems: names.map((name, i) => ({ name, users: ecoUsers[i], observations: ecoObs[i] })),
    tagEcosystemCounts,
    kinds: {
      addon: decodeKind(rk.addon, V, E, 'addon'),
      checkpoint: decodeKind(rk.checkpoint, V, E, 'checkpoint'),
    },
  };
  return { index, vocabVersion, specHash };
}
