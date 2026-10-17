import { endianness } from 'os';
import { promisify } from 'util';
import zlib from 'zlib';
import { Unpackr } from 'msgpackr';
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
 * The decoding half of the tag-index snapshot codec (`./payload` is the encoder and the public
 * entry point, and re-exports all of this). Its own module so the decode worker's bundle carries
 * only the decoder: msgpack's unpacker, no packer, and nothing from `./build` but types. Every limit
 * a decode enforces (the size caps and the fit bound) is a parameter, which the worker receives from
 * the main thread. Decoding needs a little-endian host.
 */

export const TAG_INDEX_PAYLOAD_FORMAT = 'resource-intent-tags/1';
/**
 * Holds the full-coverage index with room for its growth (docs/resource-intent-primitive.md,
 * Snapshot). The snapshot table's payloadBytes CHECK holds the same bound: change both together.
 */
export const TAG_INDEX_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
/**
 * Caps brotli's output; must admit a payload at `TAG_INDEX_MAX_PAYLOAD_BYTES` at the measured
 * inflation ratio (docs/resource-intent-primitive.md, Snapshot).
 */
export const TAG_INDEX_MAX_INFLATED_BYTES = 1024 * 1024 * 1024;
/** Content scores travel as exact integers c·10⁴: part of the wire format, like the format id. */
export const C_SCALE = 10_000;

const unpackr = new Unpackr({ useRecords: false, mapsAsObjects: true });
const NIL = Uint8Array.of(0xc0);
const brotliDecompress = promisify(zlib.brotliDecompress);

export function fail(what: string): never {
  throw new Error(`tag index payload invalid: ${what}`);
}

export type Wide = Uint16Array | Uint32Array | Float32Array | Float64Array;
type WideCtor = { new (n: number): Wide; BYTES_PER_ELEMENT: number };

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

/** The ids of `deltas`, written over `d`: every caller passes a freshly decoded array it owns. */
function undeltas(ptr: Uint32Array, d: Uint32Array, what: string): Uint32Array {
  if (ptr[ptr.length - 1] !== d.length) fail(`${what} pointer bounds`);
  for (let i = 0; i + 1 < ptr.length; i++) {
    let v = 0;
    for (let k = ptr[i]; k < ptr[i + 1]; k++) {
      v = k > ptr[i] ? v + d[k] : d[k];
      if (v > 0xffffffff) fail(`${what} id overflow`);
      d[k] = v;
    }
  }
  return d;
}

export const single = (n: number) => Uint32Array.of(0, n);

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

export async function decompressTagIndex(
  payload: Uint8Array,
  maxInflatedBytes = TAG_INDEX_MAX_INFLATED_BYTES
): Promise<Buffer> {
  return brotliDecompress(payload, { maxOutputLength: maxInflatedBytes });
}

/** The size caps a decode enforces. */
export type TagIndexDecodeCaps = { maxPayloadBytes: number; maxInflatedBytes: number };
export const TAG_INDEX_DECODE_CAPS: TagIndexDecodeCaps = {
  maxPayloadBytes: TAG_INDEX_MAX_PAYLOAD_BYTES,
  maxInflatedBytes: TAG_INDEX_MAX_INFLATED_BYTES,
};

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The arrays of a packed snapshot, checked for format and shape; `tagIndexFromData` validates the
 * index.
 */
export function unpackTagIndexData(raw: Uint8Array): {
  data: TagIndexData;
  specHash: string;
} {
  const doc = unpackr.unpack(raw) as Record<string, unknown>;
  // msgpackr keeps a DataView of the last buffer it unpacked, module-wide, until the next unpack:
  // left alone it would hold the whole inflated snapshot after the decode. One tiny unpack moves it.
  unpackr.unpack(NIL);
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

function checkSparse(
  s: SparseByKey,
  keyLimit: number,
  n: number,
  what: string,
  valueOk: (v: number) => boolean
) {
  if (s.value.length !== s.resource.length) fail(`${what} arrays`);
  checkIds(single(s.keys.length), s.keys, keyLimit, `${what} key`);
  checkPtr(s.ptr, s.keys.length, s.resource.length, what);
  checkIds(s.ptr, s.resource, n, `${what} resource`);
  for (const v of s.value) if (!valueOk(v)) fail(`${what} value`);
}

/**
 * Called once per unit of work in `assembleSteps`' loops; true when assembly should pause. Pausing
 * changes nothing about the result.
 */
type Step = () => boolean;

function* sparseIndex(s: SparseByKey, step: Step): Generator<void, Map<number, ResourceValues>> {
  const out = new Map<number, ResourceValues>();
  for (let i = 0; i < s.keys.length; i++) {
    out.set(s.keys[i], {
      resource: s.resource.subarray(s.ptr[i], s.ptr[i + 1]),
      value: s.value.subarray(s.ptr[i], s.ptr[i + 1]) as FloatArray,
    });
    if (step()) yield;
  }
  return out;
}

function checkKind(k: TagIndexKindData, V: number, E: number, kind: string, bound: number) {
  const what = (x: string) => `${kind} ${x}`;
  const ids = k.modelIds;
  const n = ids.length;
  for (let i = 1; i < n; i++) if (ids[i] <= ids[i - 1]) fail(what('model ids not ascending'));
  if (k.fit.length !== n) fail(what('fit length'));
  // A fit feeds exp() in the scorer: a finite but corrupt value would still score Infinity.
  for (const v of k.fit) {
    if (!finite(v)) fail(what('fit not finite'));
    if (Math.abs(v) > bound) fail(what('fit out of range'));
  }
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
    else if (Math.abs(fit[i]) > bound) fail(what('postings fit out of range'));
  }
  checkSparse(k.ecosystemUsers, E, n, what('ecosystemUsers'), (v) => Number.isInteger(v) && v > 0);
  checkSparse(k.userByTag, V, n, what('userByTag'), positive);
  checkSparse(k.userByEcosystem, E, n, what('userByEcosystem'), positive);
}

function* kindIndex(k: TagIndexKindData, step: Step): Generator<void, TagIndexKind> {
  const ecosystems: number[][] = [];
  for (let i = 0; i < k.modelIds.length; i++) {
    ecosystems.push(Array.from(k.ecosystemIds.subarray(k.ecosystemPtr[i], k.ecosystemPtr[i + 1])));
    if (step()) yield;
  }
  return {
    modelIds: Array.from(k.modelIds),
    fit: k.fit,
    ecosystems,
    postings: k.postings,
    ecosystemUsers: yield* sparseIndex(k.ecosystemUsers, step),
    userByTag: yield* sparseIndex(k.userByTag, step),
    userByEcosystem: yield* sparseIndex(k.userByEcosystem, step),
  };
}

/**
 * Refuses built or decoded arrays unless every precondition the scorer relies on holds: keys and
 * names in code-point order, model ids strictly ascending, CSR pointers of the right length and
 * monotone, ids in range and ascending within a row, values finite, fits within `tagFitBound`,
 * content scores in [0, 1], and the ecosystems' observations summing to the build's count of rows
 * with an ecosystem, so none (including those below the resolver's user floor) was left out.
 */
export function validateTagIndexData(data: TagIndexData, fitBound: number): void {
  // The bound is the caller's (the build's `tagFitBound()`); without a usable one every fit would
  // pass, so refuse rather than validate against nothing.
  if (!(Number.isFinite(fitBound) && fitBound > 0))
    throw new Error(`tag index decode: fit bound ${fitBound} is not a positive number`);
  if (typeof data.vocabVersion !== 'string' || !HEX64.test(data.vocabVersion)) fail('vocabVersion');
  const V = data.vocabulary.length;
  if (!V) fail('vocabulary keys');
  for (let i = 0; i < V; i++) {
    const key = data.vocabulary[i].key;
    if (typeof key !== 'string' || !key) fail('vocabulary key');
    if (i && compareCodePoints(data.vocabulary[i - 1].key, key) >= 0) fail('vocabulary key order');
  }
  data.vocabulary.forEach((t, i) => {
    if (!finite(t.idf)) fail('idf not finite');
    for (let k = 0; k < t.near.length; k++) {
      const j = t.near[k];
      if (!Number.isInteger(j) || j < 0 || j >= V) fail('near id out of range');
      if (j === i) fail('near holds its own tag');
      if (k && j <= t.near[k - 1]) fail('near id order');
    }
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
  for (let k = 0; k < tc.count.length; k++)
    if (tc.count[k] < 1 || tc.count[k] > data.ecosystems[tc.ecosystem[k]].observations)
      fail('tagEcosystemCounts count');

  checkKind(data.kinds.addon, V, E, 'addon', fitBound);
  checkKind(data.kinds.checkpoint, V, E, 'checkpoint', fitBound);
}

function* assembleSteps(data: TagIndexData, step: Step): Generator<void, TagIndex> {
  const vocabulary: TagVocabularyEntry[] = [];
  const idByKey = new Map<string, number>();
  for (let i = 0; i < data.vocabulary.length; i++) {
    const t = data.vocabulary[i];
    vocabulary.push({ key: t.key, idf: t.idf, explicit: t.explicit, near: t.near });
    idByKey.set(t.key, i);
    if (step()) yield;
  }
  const tc = data.tagEcosystemCounts;
  const tagEcosystemCounts = new Map<number, Map<number, number>>();
  for (let t = 0; t < data.vocabulary.length; t++) {
    if (tc.ptr[t + 1] === tc.ptr[t]) continue;
    const m = new Map<number, number>();
    for (let k = tc.ptr[t]; k < tc.ptr[t + 1]; k++) m.set(tc.ecosystem[k], tc.count[k]);
    tagEcosystemCounts.set(t, m);
    if (step()) yield;
  }
  const addon = yield* kindIndex(data.kinds.addon, step);
  const checkpoint = yield* kindIndex(data.kinds.checkpoint, step);
  return {
    vocabulary,
    idByKey,
    ecosystems: data.ecosystems.map((e) => ({ ...e })),
    tagEcosystemCounts,
    kinds: { addon, checkpoint },
  };
}

/** Units of work between pauses of `assembleTagIndexCooperative`. */
export const ASSEMBLE_STEP_WORK = 1 << 13;

/**
 * The scorer's index over arrays `validateTagIndexData` accepted. It checks nothing itself, so call
 * it only on validated data (`tagIndexFromData`, or the arrays the decode worker validated).
 */
export function assembleTagIndex(data: TagIndexData): TagIndex {
  const steps = assembleSteps(data, () => false);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/**
 * `assembleTagIndex`, the same index, pausing every `every` units of work to await `pause`, so a
 * real-size index is not assembled in one event-loop turn.
 */
export async function assembleTagIndexCooperative(
  data: TagIndexData,
  pause: () => Promise<void>,
  every = ASSEMBLE_STEP_WORK
): Promise<TagIndex> {
  let work = 0;
  const steps = assembleSteps(data, () => ++work % every === 0);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    await pause();
  }
}

export type DecodedTagIndex = {
  index: TagIndex;
  vocabVersion: string;
  specHash: string;
};

/**
 * Decompress, unpack and validate, without building the scorer's maps: the part the decode worker
 * runs. Does NOT compare the spec hash with the running code's, or the vocabulary version with the
 * frozen one: the caller must. `caps` and `fitBound` are the caller's: the decode worker is handed
 * them by the main thread, so it enforces the limits of the code that spawned it and carries no
 * tunable constant of its own.
 */
export async function decodeTagIndexData(
  payload: Uint8Array,
  caps: TagIndexDecodeCaps,
  fitBound: number
): Promise<{ data: TagIndexData; vocabVersion: string; specHash: string }> {
  if (payload.length > caps.maxPayloadBytes)
    throw new Error(`tag index payload ${payload.length} bytes exceeds ${caps.maxPayloadBytes}`);
  const { data, specHash } = unpackTagIndexData(
    await decompressTagIndex(payload, caps.maxInflatedBytes)
  );
  // A whole event-loop turn between unpacking and validating, for a caller decoding on its main
  // thread (the build's put).
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  validateTagIndexData(data, fitBound);
  return { data, vocabVersion: data.vocabVersion, specHash };
}

/**
 * Every ArrayBuffer under `data`'s typed arrays, once each: the transfer list that hands decoded
 * arrays to another thread without copying them.
 */
export function transferablesOf(data: TagIndexData): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const walk = (v: unknown) => {
    if (ArrayBuffer.isView(v)) {
      if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
    } else if (Array.isArray(v)) {
      for (const x of v) if (x !== null && typeof x === 'object') walk(x);
    } else if (v !== null && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(data);
  return [...out];
}
