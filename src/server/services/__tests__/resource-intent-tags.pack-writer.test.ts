import { brotliDecompressSync } from 'zlib';
import { Packr } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import type {
  SparseByKey,
  TagIndexData,
  TagIndexKindData,
} from '~/server/services/resource-intent-tags/build';
import {
  packTagIndex,
  encodeTagIndexCooperative,
  TAG_INDEX_PAYLOAD_FORMAT,
} from '~/server/services/resource-intent-tags/payload';
import { smallTagIndexData } from './resource-intent-tags.fixture';

/**
 * `packTagIndex` writes msgpack itself, straight into one buffer. These tests hold it byte for byte to
 * the msgpackr encoding it replaced (the reference below is that code: shuffled arrays in a document
 * packed by `msgpackr` with `useRecords: false`), on the fixture and on documents shaped to cross every
 * size boundary of a msgpack header the writer chooses: strings, arrays, binaries and integers.
 */

const packr = new Packr({ useRecords: false, mapsAsObjects: true });
type Wide = Uint16Array | Uint32Array | Float32Array | Float64Array;

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
const lengths = (ptr: Uint32Array) =>
  Uint32Array.from({ length: ptr.length - 1 }, (_, i) => ptr[i + 1] - ptr[i]);
function deltas(ptr: Uint32Array, ids: Uint32Array): Uint32Array {
  const out = new Uint32Array(ids.length);
  for (let i = 0; i + 1 < ptr.length; i++)
    for (let k = ptr[i]; k < ptr[i + 1]; k++) out[k] = k > ptr[i] ? ids[k] - ids[k - 1] : ids[k];
  return out;
}
const single = (n: number) => Uint32Array.of(0, n);
const sparse = (s: SparseByKey, integer: boolean) => ({
  keys: shuffle(deltas(single(s.keys.length), s.keys)),
  len: shuffle(lengths(s.ptr)),
  resource: shuffle(deltas(s.ptr, s.resource)),
  value: shuffle(integer ? Uint32Array.from(s.value) : Float32Array.from(s.value)),
});
function kind(k: TagIndexKindData) {
  const { ptr, resource, c, fit } = k.postings;
  const present = new Uint8Array(Math.ceil(fit.length / 8));
  const fits: number[] = [];
  const cInt = new Uint16Array(c.length);
  for (let i = 0; i < c.length; i++) {
    cInt[i] = Math.round(c[i] * 10_000);
    if (!Number.isNaN(fit[i])) {
      present[i >> 3] |= 1 << (i & 7);
      fits.push(fit[i]);
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
      fit: shuffle(Float32Array.from(fits)),
    },
    ecosystemUsers: sparse(k.ecosystemUsers, true),
    userByTag: sparse(k.userByTag, false),
    userByEcosystem: sparse(k.userByEcosystem, false),
  };
}
/** The msgpackr encoding `packTagIndex` replaced. */
function referencePack(data: TagIndexData, specHash: string): Buffer {
  const v = data.vocabulary;
  const nearPtr = new Uint32Array(v.length + 1);
  v.forEach((t, i) => (nearPtr[i + 1] = nearPtr[i] + t.near.length));
  const near = Uint32Array.from(v.flatMap((t) => t.near));
  const tc = data.tagEcosystemCounts;
  return Buffer.from(
    packr.pack({
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
      kinds: { addon: kind(data.kinds.addon), checkpoint: kind(data.kinds.checkpoint) },
    })
  );
}

const SPEC = 'd'.repeat(64);
const base = () => smallTagIndexData('c'.repeat(64));

/** The fixture with a vocabulary of `n` tags (keys of `keyLen` characters) and `e` ecosystems. */
function shaped(n: number, keyLen: number, e: number, rowsWithEcosystem: number): TagIndexData {
  const d = base();
  const pad = (i: number) => `k${i}`.padEnd(keyLen, 'x');
  d.vocabulary = Array.from({ length: n }, (_, i) => ({
    key: pad(i),
    idf: 1 + i / 7,
    users: i * 9973,
    explicit: i % 3 === 0,
    near: i % 5 === 0 && i + 1 < n ? [i + 1] : [],
  }));
  d.ecosystems = Array.from({ length: e }, (_, i) => ({
    name: `eco-${i}`.padEnd(keyLen, 'é'),
    users: i,
    observations: i * 2,
  }));
  d.rowsWithEcosystem = rowsWithEcosystem;
  return d;
}

describe('packTagIndex writes what msgpackr wrote', () => {
  it('on the fixture', () => {
    const d = base();
    expect(packTagIndex(d, SPEC).equals(referencePack(d, SPEC))).toBe(true);
  });

  // Boundaries: fixarray < 16 ≤ array16 < 65,536 ≤ array32; fixstr < 32 ≤ str8 < 256 ≤ str16 <
  // 65,536 ≤ str32 (UTF-8 bytes, 'é' is two); bin8 < 256 ≤ bin16 < 65,536 ≤ bin32 (the vocabulary's
  // `explicit` is n bytes, its `users` 4n); positive fixint < 128 ≤ uint8 < 256 ≤ uint16 < 65,536 ≤
  // uint32.
  it.each([
    [15, 31, 15, 127],
    [16, 32, 16, 128],
    [63, 255, 3, 255],
    [64, 256, 3, 256],
    [255, 3, 1, 65_535],
    [256, 3, 1, 65_536],
    [16_383, 2, 0, 0],
    [16_384, 2, 0, 4_294_967_295],
    [65_535, 1, 2, 7],
    [65_536, 1, 2, 7],
    [3, 65_535, 1, 7],
    [3, 65_536, 1, 7],
  ])('vocabulary %i tags of %i chars, %i ecosystems, rowsWithEcosystem %i', (n, len, e, rows) => {
    const d = shaped(n, len, e, rows);
    expect(packTagIndex(d, SPEC).equals(referencePack(d, SPEC))).toBe(true);
  });

  it('cooperatively too, and consuming', async () => {
    const d = shaped(300, 40, 20, 1234);
    const ref = referencePack(d, SPEC);
    const unpacked = async (p: Promise<Buffer>) => brotliDecompressSync(await p);
    expect(
      (await unpacked(encodeTagIndexCooperative(d, SPEC, async () => undefined))).equals(ref)
    ).toBe(true);
    const consumed = shaped(300, 40, 20, 1234);
    const raw = await unpacked(
      encodeTagIndexCooperative(consumed, SPEC, async () => undefined, { every: 7, consume: true })
    );
    expect(raw.equals(ref)).toBe(true);
  });

  it('refuses a rowsWithEcosystem that is not a uint32', () => {
    expect(() => packTagIndex(shaped(3, 3, 1, 2 ** 32), SPEC)).toThrow('is not a uint32');
    expect(() => packTagIndex(shaped(3, 3, 1, 1.5), SPEC)).toThrow('is not a uint32');
  });
});
