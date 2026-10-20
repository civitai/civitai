import { Packr } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import { tagFitBound } from '~/server/services/resource-intent-tags/build';
import type { TagIndexData } from '~/server/services/resource-intent-tags/build';
import { brotliCompressSync } from 'zlib';
import {
  decodeTagIndex,
  decompressTagIndex,
  encodeTagIndex,
  packTagIndex,
  TAG_INDEX_MAX_INFLATED_BYTES,
  TAG_INDEX_MAX_PAYLOAD_BYTES,
  tagIndexFromData,
  unpackTagIndex,
  unpackTagIndexData,
} from '~/server/services/resource-intent-tags/payload';
import { smallTagIndexData } from './resource-intent-tags.fixture';

const data = smallTagIndexData('c'.repeat(64));
const packr = new Packr({ useRecords: false, mapsAsObjects: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an unpacked snapshot, edited field by field
type Doc = Record<string, any>;

/** Unpack the valid snapshot, apply `edit`, repack, decode. */
function decodeEdited(edit: (doc: Doc) => void) {
  const doc = packr.unpack(packTagIndex(data, 'd'.repeat(64))) as Doc;
  edit(doc);
  return () => unpackTagIndex(packr.pack(doc));
}

/** A copy of the valid build with `edit` applied, validated. */
function validateEdited(edit: (d: TagIndexData) => void) {
  const d = structuredClone(data);
  edit(d);
  return () => tagIndexFromData(d);
}

describe('resource-intent-tags snapshot codec', () => {
  it('round-trips: ids exact, values as float32, idf as float64, header kept', async () => {
    const payload = await encodeTagIndex(data, 'd'.repeat(64));
    const { index, vocabVersion, specHash } = await decodeTagIndex(payload);
    expect(vocabVersion).toBe('c'.repeat(64));
    expect(specHash).toBe('d'.repeat(64));
    expect(index.vocabulary.map((t) => [t.key, t.idf, t.explicit, t.near])).toEqual(
      data.vocabulary.map((t) => [t.key, t.idf, t.explicit, t.near])
    );
    expect(index.ecosystems).toEqual(data.ecosystems);
    expect(data.vocabulary[0].near).toEqual([2, 3]);
    const p = data.kinds.addon.postings;
    expect([...p.resource.subarray(p.ptr[2], p.ptr[3])]).toEqual([0, 1, 2]);
    for (const kind of ['addon', 'checkpoint'] as const) {
      const k = data.kinds[kind];
      const d = index.kinds[kind];
      expect(d.modelIds).toEqual([...k.modelIds]);
      expect(d.ecosystems).toEqual(
        d.modelIds.map((_, i) => [
          ...k.ecosystemIds.subarray(k.ecosystemPtr[i], k.ecosystemPtr[i + 1]),
        ])
      );
      expect([...d.fit]).toEqual([...k.fit].map(Math.fround));
      expect([...d.postings.ptr]).toEqual([...k.postings.ptr]);
      expect([...d.postings.resource]).toEqual([...k.postings.resource]);
      expect([...d.postings.c]).toEqual([...k.postings.c].map(Math.fround));
      expect([...d.postings.fit].map(String)).toEqual(
        [...k.postings.fit].map((v) => String(Math.fround(v)))
      );
      for (const name of ['userByTag', 'userByEcosystem', 'ecosystemUsers'] as const) {
        const s = k[name];
        const got = [...d[name]].map(([key, v]) => [key, [...v.resource], [...v.value]]);
        expect(got).toEqual(
          [...s.keys].map((key, i) => [
            key,
            [...s.resource.subarray(s.ptr[i], s.ptr[i + 1])],
            [...s.value.subarray(s.ptr[i], s.ptr[i + 1])].map(Math.fround),
          ])
        );
      }
    }
    expect(data.kinds.addon.postings.fit.some(Number.isNaN)).toBe(true);
    expect(data.kinds.addon.postings.fit.some((v) => !Number.isNaN(v))).toBe(true);
    expect([...(index.tagEcosystemCounts.get(0) as Map<number, number>)]).toEqual([
      [0, 6],
      [1, 2],
    ]);
  });

  it('keeps an ecosystem below the resolver floor, and one with no training rows', () => {
    expect(data.ecosystems.map((e) => [e.name, e.users, e.observations])).toEqual([
      ['E1', 3, 6],
      ['E2', 1, 2],
      ['E3', 0, 0],
    ]);
  });

  it('carries a content score of exactly 1', async () => {
    const d = structuredClone(data);
    d.kinds.addon.postings.c[0] = 1;
    const { index } = await decodeTagIndex(await encodeTagIndex(d, 'd'.repeat(64)));
    expect(index.kinds.addon.postings.c[0]).toBe(1);
  });

  it.each([0.12345, 1.5, -0.1])(
    'refuses to encode a content score %s that is not a multiple of 1/10000 in [0, 1]',
    async (c) => {
      const d = structuredClone(data);
      d.kinds.addon.postings.c[0] = c;
      await expect(encodeTagIndex(d, 'd'.repeat(64))).rejects.toThrow('not a multiple of 1/10000');
    }
  );

  it.each([2.5, -1, 2 ** 32])(
    'refuses to encode a popularity count %s that is not a uint32',
    async (v) => {
      const d = structuredClone(data);
      d.kinds.addon.ecosystemUsers.value[0] = v;
      await expect(encodeTagIndex(d, 'd'.repeat(64))).rejects.toThrow('is not a uint32');
    }
  );

  it('refuses a payload above the size cap before decompressing it', async () => {
    await expect(decodeTagIndex(new Uint8Array(TAG_INDEX_MAX_PAYLOAD_BYTES + 1))).rejects.toThrow(
      'exceeds'
    );
  });

  // Literal sizes, not the constant: the cap must admit a payload the size of the real index.
  it.each([
    ['256 MiB + 1', 256 * 1024 * 1024 + 1, true],
    ['256 MiB', 256 * 1024 * 1024, false],
    ['the full-coverage index (153,063,918 B, 2026-10-17 dry run)', 153_063_918, false],
    ['the old 128 MiB cap + 1', 128 * 1024 * 1024 + 1, false],
  ])(
    'size cap at %s (%i bytes): refused before decompression = %s',
    async (_name, size, refused) => {
      const err = await decodeTagIndex(new Uint8Array(size)).then(
        () => null,
        (e: Error) => e
      );
      // Below the cap the zero bytes reach brotli, which fails on them for its own reason.
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message.includes('exceeds')).toBe(refused);
    }
  );

  it('pins the caps: 256 MiB compressed, 1 GiB inflated', () => {
    expect(TAG_INDEX_MAX_PAYLOAD_BYTES).toBe(268_435_456);
    expect(TAG_INDEX_MAX_INFLATED_BYTES).toBe(1_073_741_824);
    // The inflated cap admits a payload at the compressed cap at the measured full-coverage ratio
    // (392,594,256 B of msgpack in 153,063,918 B of payload, 2026-10-17 dry run), with room to spare.
    const ratio = 392_594_256 / 153_063_918;
    expect(TAG_INDEX_MAX_PAYLOAD_BYTES * ratio * 1.25).toBeLessThan(TAG_INDEX_MAX_INFLATED_BYTES);
  });

  it('the unpacked index holds nothing of the packed bytes once unpacked', async () => {
    const v8 = await import('v8');
    const vm = await import('vm');
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc') as () => void;
    // Its own ArrayBuffer (not a pooled slab), so the weak reference sees exactly these bytes.
    let raw: Uint8Array | null = new Uint8Array(packTagIndex(data, 'd'.repeat(64)));
    const bytes = new WeakRef(raw.buffer);
    const { data: unpacked } = unpackTagIndexData(raw);
    raw = null;
    await new Promise((r) => setTimeout(r, 0));
    gc();
    gc();
    expect(bytes.deref()).toBeUndefined();
    expect(unpacked.vocabulary.length).toBe(data.vocabulary.length);
  });

  it('accepts float32 content scores that are the float32 of k/10^4, and refuses any other', async () => {
    const f32 = structuredClone(data);
    for (const kind of ['addon', 'checkpoint'] as const) {
      const p = f32.kinds[kind].postings;
      p.c = Float32Array.from(p.c);
      p.fit = Float32Array.from(p.fit);
    }
    // The same bytes as the float64 build: the snapshot stores these at float32 anyway.
    expect(packTagIndex(f32, 'd'.repeat(64)).equals(packTagIndex(data, 'd'.repeat(64)))).toBe(true);
    const off = structuredClone(f32);
    const k = off.kinds.addon.postings.c.findIndex((v) => v > 0);
    off.kinds.addon.postings.c[k] = Math.fround(off.kinds.addon.postings.c[k] + 0.00004);
    expect(() => packTagIndex(off, 'd'.repeat(64))).toThrow('is not a multiple of 1/10000');
  });

  it('refuses to inflate past the inflated cap, and admits exactly up to it', async () => {
    const bytes = brotliCompressSync(Buffer.alloc(1001, 7));
    await expect(decompressTagIndex(bytes, 1000)).rejects.toMatchObject({
      code: 'ERR_BUFFER_TOO_LARGE',
    });
    await expect(decompressTagIndex(bytes, 1001)).resolves.toHaveLength(1001);
  });

  it.each<[string, (d: Doc) => void, string]>([
    ['an unknown format', (d) => (d.format = 'resource-intent-tags/0'), 'unknown format'],
    ['a malformed spec hash', (d) => (d.specHash = 'D'.repeat(64)), 'invalid: specHash'],
    ['a malformed vocabulary version', (d) => (d.vocabVersion = 'abc'), 'invalid: vocabVersion'],
    [
      'a content score above 1',
      (d) => {
        const c = Buffer.from(d.kinds.addon.postings.c);
        c[0] = 0xff;
        c[c.length / 2] = 0xff;
        d.kinds.addon.postings.c = c;
      },
      'addon postings c above 1',
    ],
    [
      'a fit presence bitmap that disagrees with the fit values',
      (d) => {
        d.kinds.addon.postings.fitPresent = Buffer.alloc(d.kinds.addon.postings.fitPresent.length);
      },
      'addon postings fit presence',
    ],
    [
      'an explicit flag that is neither 0 nor 1',
      (d) => (d.vocabulary.explicit = Buffer.from([2, 0, 0, 0])),
      'explicit flag',
    ],
    ['a field that is not binary', (d) => (d.kinds.addon.fit = [1, 2]), 'addon fit is not binary'],
    [
      'a fit presence bitmap of the wrong length',
      (d) => {
        const f = d.kinds.addon.postings.fitPresent;
        d.kinds.addon.postings.fitPresent = Buffer.concat([f, Buffer.alloc(1)]);
      },
      'addon postings fit presence',
    ],
    [
      'near lengths that sum short of the near ids',
      (d) => (d.vocabulary.nearLen = Buffer.from([2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
      'near pointer bounds',
    ],
    [
      'near lengths that sum past the near ids',
      (d) => (d.vocabulary.nearLen = Buffer.from([2, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
      'near pointer bounds',
    ],
    [
      'a near pointer of the wrong length',
      (d) => (d.vocabulary.nearLen = Buffer.from([2, 2, 0, 0, 0, 0, 0, 0])),
      'near pointer length',
    ],
  ])('refuses %s on the wire', (_name, edit, message) => {
    expect(decodeEdited(edit)).toThrow(message);
  });

  const n = (d: TagIndexData) => d.kinds.addon.modelIds.length;
  it.each<[string, (d: TagIndexData) => void, string | RegExp]>([
    ['an empty vocabulary', (d) => (d.vocabulary = []), 'vocabulary keys'],
    [
      'vocabulary keys out of order',
      (d) => {
        d.vocabulary = [d.vocabulary[1], d.vocabulary[0], ...d.vocabulary.slice(2)];
      },
      'vocabulary key order',
    ],
    ['a non-finite idf', (d) => (d.vocabulary[2].idf = NaN), 'idf not finite'],
    ['a near id out of range', (d) => (d.vocabulary[2].near = [4]), 'near id out of range'],
    [
      'a near set holding its own tag',
      (d) => (d.vocabulary[0].near = [0]),
      'near holds its own tag',
    ],
    ['a near set out of order', (d) => (d.vocabulary[2].near = [1, 0]), 'near id order'],
    [
      'ecosystem names out of order',
      (d) => {
        [d.ecosystems[0].name, d.ecosystems[1].name] = [d.ecosystems[1].name, d.ecosystems[0].name];
      },
      'ecosystem name order',
    ],
    [
      'a missing ecosystem, even one below the floor',
      (d) => {
        d.ecosystems.splice(1, 1);
      },
      'ecosystem observations do not sum to the rows with an ecosystem',
    ],
    [
      "a (tag, ecosystem) count above the ecosystem's rows",
      (d) => {
        d.tagEcosystemCounts.count[0] = 99;
      },
      'tagEcosystemCounts count',
    ],
    [
      'a (tag, ecosystem) ecosystem id out of range',
      (d) => {
        d.tagEcosystemCounts.ecosystem[d.tagEcosystemCounts.ecosystem.length - 1] = 7;
      },
      'tagEcosystemCounts ecosystem id out of range',
    ],
    [
      'a (tag, ecosystem) pointer of the wrong length',
      (d) => {
        d.tagEcosystemCounts.ptr = d.tagEcosystemCounts.ptr.slice(1);
      },
      'tagEcosystemCounts pointer length',
    ],
    [
      'model ids not strictly ascending',
      (d) => {
        const ids = d.kinds.addon.modelIds;
        [ids[0], ids[1]] = [ids[1], ids[0]];
      },
      'addon model ids not ascending',
    ],
    [
      'a resource fit array of the wrong length',
      (d) => {
        d.kinds.addon.fit = d.kinds.addon.fit.slice(1);
      },
      'addon fit length',
    ],
    ['a non-finite resource fit', (d) => (d.kinds.addon.fit[0] = Infinity), 'addon fit not finite'],
    // Finite, so it passes every earlier check, and exp() of it scores Infinity.
    [
      'a resource fit beyond the fit bound',
      (d) => (d.kinds.addon.fit[0] = 268670.6),
      'addon fit out of range',
    ],
    [
      'a pair fit beyond the fit bound',
      (d) => {
        const { fit } = d.kinds.addon.postings;
        fit[fit.findIndex((v) => !Number.isNaN(v))] = -2.5;
      },
      'addon postings fit out of range',
    ],
    [
      'a published ecosystem id out of range',
      (d) => {
        d.kinds.addon.ecosystemIds[0] = 9;
      },
      'addon ecosystem id out of range',
    ],
    [
      'a postings pointer that is not vocabulary size + 1',
      (d) => {
        const p = d.kinds.addon.postings.ptr;
        d.kinds.addon.postings.ptr = Uint32Array.from([...p, p[p.length - 1]]);
      },
      'addon postings pointer length',
    ],
    [
      'postings resources out of order',
      (d) => {
        const { ptr, resource } = d.kinds.addon.postings;
        const t = [...ptr].findIndex((v, i) => i + 1 < ptr.length && ptr[i + 1] - v >= 2);
        [resource[ptr[t]], resource[ptr[t] + 1]] = [resource[ptr[t] + 1], resource[ptr[t]]];
      },
      'addon postings resource id order',
    ],
    ['a content score above 1', (d) => (d.kinds.addon.postings.c[0] = 1.5), 'addon postings c'],
    ['a NaN content score', (d) => (d.kinds.addon.postings.c[0] = NaN), 'addon postings c'],
    [
      'an entry with neither a content score nor a fit',
      (d) => {
        const { c, fit } = d.kinds.addon.postings;
        const k = fit.findIndex(Number.isNaN);
        c[k] = 0;
      },
      'addon postings entry with neither c nor fit',
    ],
    [
      'an infinite pair fit',
      (d) => {
        const { fit } = d.kinds.addon.postings;
        fit[fit.findIndex((v) => !Number.isNaN(v))] = Infinity;
      },
      'addon postings fit not finite',
    ],
    [
      'a user-side resource out of range',
      (d) => {
        d.kinds.addon.userByTag.resource[0] = n(d);
      },
      'addon userByTag resource id out of range',
    ],
    [
      'a user-side key out of range',
      (d) => {
        const k = d.kinds.addon.userByTag.keys;
        k[k.length - 1] = 4;
      },
      'addon userByTag key id out of range',
    ],
    [
      'user-side keys out of order',
      (d) => {
        const k = d.kinds.addon.userByEcosystem.keys;
        [k[0], k[1]] = [k[1], k[0]];
      },
      'addon userByEcosystem key id order',
    ],
    ['an empty vocabulary key', (d) => (d.vocabulary[3].key = ''), /vocabulary key$/],
    ['an empty ecosystem name', (d) => (d.ecosystems[0].name = ''), /ecosystem name$/],
    [
      'a pointer that does not start at 0',
      (d) => (d.kinds.addon.postings.ptr[0] = 1),
      'addon postings pointer bounds',
    ],
    [
      'a pointer that ends short of its array',
      (d) => {
        const p = d.kinds.addon.postings.ptr;
        p[p.length - 1] -= 1;
      },
      'addon postings pointer bounds',
    ],
    [
      'a pointer that ends past its array',
      (d) => {
        const p = d.kinds.addon.postings.ptr;
        p[p.length - 1] += 1;
      },
      'addon postings pointer bounds',
    ],
    [
      'a decreasing pointer',
      (d) => {
        const p = d.kinds.addon.postings.ptr;
        p[1] = p[p.length - 1];
      },
      'addon postings pointer order',
    ],
    [
      '(tag, ecosystem) arrays of different lengths',
      (d) => {
        d.tagEcosystemCounts.count = d.tagEcosystemCounts.count.slice(1);
      },
      'tagEcosystemCounts arrays',
    ],
    [
      'a (tag, ecosystem) count below 1',
      (d) => (d.tagEcosystemCounts.count[0] = 0),
      'tagEcosystemCounts count',
    ],
    [
      'postings arrays of different lengths',
      (d) => {
        d.kinds.addon.postings.c = d.kinds.addon.postings.c.slice(1);
      },
      'addon postings arrays',
    ],
    [
      'user-side arrays of different lengths',
      (d) => {
        d.kinds.addon.userByTag.value = d.kinds.addon.userByTag.value.slice(1);
      },
      'addon userByTag arrays',
    ],
    [
      'a non-positive user-side share',
      (d) => (d.kinds.addon.userByTag.value[0] = 0),
      'addon userByTag value',
    ],
    [
      'a fractional popularity count',
      (d) => (d.kinds.addon.ecosystemUsers.value[0] = 1.5),
      'addon ecosystemUsers value',
    ],
  ])('refuses %s', (_name, edit, message) => {
    expect(validateEdited(edit)).toThrow(message);
  });

  it('bounds fits at 2, the range of the outcomes they average', () => {
    expect(tagFitBound()).toBe(2);
  });

  it('accepts fits inside the bound but beyond 1', () => {
    const d = structuredClone(data);
    d.kinds.addon.fit[0] = 1.9;
    const { fit } = d.kinds.addon.postings;
    fit[fit.findIndex((v) => !Number.isNaN(v))] = -1.9;
    expect(() => tagIndexFromData(d)).not.toThrow();
  });

  it('accepts fits exactly at the fit bound', () => {
    const d = structuredClone(data);
    d.kinds.addon.fit[0] = tagFitBound();
    const { fit } = d.kinds.addon.postings;
    fit[fit.findIndex((v) => !Number.isNaN(v))] = -tagFitBound();
    expect(() => tagIndexFromData(d)).not.toThrow();
  });

  it('accepts the valid build as built (float64) and as decoded (float32)', async () => {
    expect(() => tagIndexFromData(data)).not.toThrow();
    await expect(decodeTagIndex(await encodeTagIndex(data, 'd'.repeat(64)))).resolves.toBeDefined();
  });
});
