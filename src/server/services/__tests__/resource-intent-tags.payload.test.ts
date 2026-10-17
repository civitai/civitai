import { Packr } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import type { TagTrainingRow } from '~/server/services/resource-intent-tags/build';
import { TagIndexAccumulator } from '~/server/services/resource-intent-tags/build';
import {
  decodeTagIndex,
  encodeTagIndex,
  packTagIndex,
  TAG_INDEX_MAX_PAYLOAD_BYTES,
  unpackTagIndex,
} from '~/server/services/resource-intent-tags/payload';
import { RESOURCE_INTENT_TAGS_SPEC } from '~/server/services/resource-intent-tags/spec';

/** A small build: three tags (one explicit, two near each other), three ecosystems, two kinds. */
function smallData() {
  const tags = [
    { key: 'amber kite', idf: 2.5, users: 30, explicit: false, near: [1] },
    { key: 'brass owl', idf: 1.25, users: 60, explicit: true, near: [0] },
    { key: 'cobalt fern', idf: 0.5, users: 90, explicit: false, near: [] },
  ];
  const acc = new TagIndexAccumulator(
    { vocabVersion: 'c'.repeat(64), tags, idByKey: new Map(tags.map((t, i) => [t.key, i])) },
    { addonTypes: RESOURCE_INTENT_TAGS_SPEC.build.addonTypes, excludeGenPrompt: () => false }
  );
  const content = { description: '', tags: [], trigger: [], gallery: [] as string[] };
  acc.addModel({
    ...content,
    modelId: 7,
    type: 'LORA',
    name: 'Amber Kite',
    baseModels: ['E1'],
    showcase: [],
  });
  acc.addModel({
    ...content,
    modelId: 3,
    type: 'LORA',
    name: 'Brass Owl, Cobalt Fern',
    baseModels: ['E3'],
    showcase: [],
  });
  acc.addModel({
    ...content,
    modelId: 9,
    type: 'Checkpoint',
    name: 'Cobalt Fern',
    baseModels: ['E1'],
    showcase: [],
  });
  const ck = (bm: string) => ({ modelId: 9, type: 'Checkpoint', baseModel: bm });
  const lora = (m: number) => ({ modelId: m, type: 'LORA', baseModel: 'E1' });
  const rows: TagTrainingRow[] = [];
  for (const [u, bm] of [
    ['a', 'E1'],
    ['b', 'E1'],
    ['c', 'E2'],
    ['d', 'E1'],
  ] as const)
    rows.push(
      {
        source: 'gen',
        user: u,
        prompt: 'amber kite, cobalt fern',
        resources: [ck(bm), lora(7)],
        liked: u === 'a',
        favorite: false,
        disliked: u === 'b',
      },
      {
        source: 'post',
        user: u,
        prompt: 'brass owl, amber kite',
        resources: [ck(bm), lora(3), lora(7)],
        reactions: u.charCodeAt(0) % 5,
        tips: u === 'c' ? 1 : 0,
      }
    );
  for (const r of rows) acc.addRow(r);
  return acc.finalize().data;
}

const data = smallData();
const packr = new Packr({ useRecords: false, mapsAsObjects: true });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an unpacked snapshot, edited field by field
type Doc = Record<string, any>;

const readU32 = (b: Uint8Array) => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Array.from({ length: b.length / 4 }, (_, i) => dv.getUint32(i * 4, true));
};
const writeU32 = (a: number[]) => {
  const out = Buffer.alloc(a.length * 4);
  a.forEach((v, i) => out.writeUInt32LE(v, i * 4));
  return out;
};
const writeF32 = (a: number[]) => {
  const out = Buffer.alloc(a.length * 4);
  a.forEach((v, i) => out.writeFloatLE(v, i * 4));
  return out;
};
const readF32 = (b: Uint8Array) => {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return Array.from({ length: b.length / 4 }, (_, i) => dv.getFloat32(i * 4, true));
};

/** Unpack the valid snapshot, apply `edit`, repack, decode. */
function decodeEdited(edit: (doc: Doc) => void) {
  const doc = packr.unpack(packTagIndex(data, 'd'.repeat(64))) as Doc;
  edit(doc);
  return () => unpackTagIndex(packr.pack(doc));
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
    const k = data.kinds.addon;
    const d = index.kinds.addon;
    expect(d.modelIds).toEqual([...k.modelIds]);
    expect([...d.fit]).toEqual([...k.fit].map(Math.fround));
    expect([...d.postings.ptr]).toEqual([...k.postings.ptr]);
    expect([...d.postings.c]).toEqual([...k.postings.c].map(Math.fround));
    expect([...d.postings.fit].map(String)).toEqual(
      [...k.postings.fit].map((v) => String(Math.fround(v)))
    );
    const tagged = [...d.userByTag].map(([t, v]) => [t, [...v.resource], [...v.value]]);
    expect(tagged.length).toBeGreaterThan(0);
    for (const [t, res, val] of tagged) {
      const i = [...k.userByTag.keys].indexOf(t as number);
      const s = k.userByTag;
      expect(res).toEqual([...s.resource.subarray(s.ptr[i], s.ptr[i + 1])]);
      expect(val).toEqual([...s.value.subarray(s.ptr[i], s.ptr[i + 1])].map(Math.fround));
    }
    const counts = index.tagEcosystemCounts.get(0) as Map<number, number>;
    expect([...counts]).toEqual([
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

  it('refuses a payload above the size cap before decompressing it', async () => {
    await expect(decodeTagIndex(new Uint8Array(TAG_INDEX_MAX_PAYLOAD_BYTES + 1))).rejects.toThrow(
      'exceeds'
    );
  });

  it('refuses an unknown format, version or spec hash', () => {
    expect(decodeEdited((d) => (d.format = 'resource-intent-tags/0'))).toThrow('unknown format');
    expect(decodeEdited((d) => (d.vocabVersion = 'abc'))).toThrow('invalid: vocabVersion');
    expect(decodeEdited((d) => (d.specHash = 'D'.repeat(64)))).toThrow('invalid: specHash');
  });

  it('refuses model ids that are not strictly ascending', () => {
    const edit = decodeEdited((d) => {
      const ids = readU32(d.kinds.addon.modelIds);
      d.kinds.addon.modelIds = writeU32([ids[1], ids[0], ...ids.slice(2)]);
    });
    expect(edit).toThrow('addon model ids not ascending');
  });

  it('refuses a postings pointer that is not vocabulary size + 1', () => {
    const edit = decodeEdited((d) => {
      const ptr = readU32(d.kinds.addon.postings.ptr);
      d.kinds.addon.postings.ptr = writeU32([...ptr, ptr[ptr.length - 1]]);
    });
    expect(edit).toThrow('addon postings pointer length');
  });

  it('refuses a non-finite resource fit', () => {
    const edit = decodeEdited((d) => {
      const fit = readF32(d.kinds.addon.fit);
      d.kinds.addon.fit = writeF32([Infinity, ...fit.slice(1)]);
    });
    expect(edit).toThrow('addon fit not finite');
  });

  it('refuses a NaN content score, and an entry with neither a content score nor a fit', () => {
    const nanC = decodeEdited((d) => {
      const c = readF32(d.kinds.addon.postings.c);
      d.kinds.addon.postings.c = writeF32([NaN, ...c.slice(1)]);
    });
    expect(nanC).toThrow('addon postings c');
    const empty = decodeEdited((d) => {
      const c = readF32(d.kinds.addon.postings.c);
      const fit = readF32(d.kinds.addon.postings.fit);
      const k = fit.findIndex((v) => Number.isNaN(v));
      expect(k).toBeGreaterThanOrEqual(0);
      c[k] = 0;
      d.kinds.addon.postings.c = writeF32(c);
    });
    expect(empty).toThrow('addon postings entry with neither c nor fit');
  });

  it('refuses a resource index out of range in a user-side list', () => {
    const edit = decodeEdited((d) => {
      const res = readU32(d.kinds.addon.userByTag.resource);
      d.kinds.addon.userByTag.resource = writeU32([99, ...res.slice(1)]);
    });
    expect(edit).toThrow('addon userByTag resource id out of range');
  });

  it('refuses an ecosystem id out of range in the (tag, ecosystem) counts', () => {
    const edit = decodeEdited((d) => {
      const e = readU32(d.tagEcosystemCounts.ecosystem);
      d.tagEcosystemCounts.ecosystem = writeU32([...e.slice(0, -1), 7]);
    });
    expect(edit).toThrow('tagEcosystemCounts ecosystem id out of range');
  });

  it('refuses a payload missing an ecosystem the rows used, even one below the floor', () => {
    const edit = decodeEdited((d) => {
      const keep = [0, 2];
      d.ecosystems.names = keep.map((i) => d.ecosystems.names[i]);
      d.ecosystems.users = writeU32(keep.map((i) => readU32(d.ecosystems.users)[i]));
      d.ecosystems.observations = writeU32(keep.map((i) => readU32(d.ecosystems.observations)[i]));
    });
    expect(edit).toThrow('ecosystem observations do not sum to the rows with an ecosystem');
  });

  it('refuses a near set holding its own tag', () => {
    const edit = decodeEdited((d) => {
      d.vocabulary.near = writeU32([0, 0]);
    });
    expect(edit).toThrow('near holds its own tag');
  });
});
