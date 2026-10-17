import { Packr } from 'msgpackr';
import { describe, expect, it } from 'vitest';
import type { TagTrainingRow } from '~/server/services/resource-intent-tags/build';
import { TagIndexAccumulator } from '~/server/services/resource-intent-tags/build';
import type { TagIndexData } from '~/server/services/resource-intent-tags/build';
import {
  decodeTagIndex,
  encodeTagIndex,
  packTagIndex,
  TAG_INDEX_MAX_PAYLOAD_BYTES,
  tagIndexFromData,
  unpackTagIndex,
} from '~/server/services/resource-intent-tags/payload';
import { RESOURCE_INTENT_TAGS_SPEC } from '~/server/services/resource-intent-tags/spec';

/** A small build: three tags (one explicit, two near each other), three ecosystems, two kinds. */
function smallData() {
  const tags = [
    { key: 'amber kite', idf: Math.log(100 / 30), users: 30, explicit: false, near: [1] },
    { key: 'brass owl', idf: Math.log(100 / 60), users: 60, explicit: true, near: [0] },
    { key: 'cobalt fern', idf: Math.log(100 / 90), users: 90, explicit: false, near: [] },
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
    for (const kind of ['addon', 'checkpoint'] as const) {
      const k = data.kinds[kind];
      const d = index.kinds[kind];
      expect(d.modelIds).toEqual([...k.modelIds]);
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

  it('refuses to encode a content score that is not a multiple of 1/10000', async () => {
    const d = structuredClone(data);
    d.kinds.addon.postings.c[0] = 0.12345;
    await expect(encodeTagIndex(d, 'd'.repeat(64))).rejects.toThrow('not a multiple of 1/10000');
  });

  it('refuses a payload above the size cap before decompressing it', async () => {
    await expect(decodeTagIndex(new Uint8Array(TAG_INDEX_MAX_PAYLOAD_BYTES + 1))).rejects.toThrow(
      'exceeds'
    );
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
      (d) => (d.vocabulary.explicit = Buffer.from([2, 0, 0])),
      'explicit flag',
    ],
    ['a field that is not binary', (d) => (d.kinds.addon.fit = [1, 2]), 'addon fit is not binary'],
    [
      'a near pointer of the wrong length',
      (d) => (d.vocabulary.nearLen = Buffer.from([1, 1, 0, 0, 0, 0, 0, 0])),
      'near pointer length',
    ],
  ])('refuses %s on the wire', (_name, edit, message) => {
    expect(decodeEdited(edit)).toThrow(message);
  });

  const n = (d: TagIndexData) => d.kinds.addon.modelIds.length;
  it.each<[string, (d: TagIndexData) => void, string]>([
    ['an empty vocabulary', (d) => (d.vocabulary = []), 'vocabulary keys'],
    [
      'vocabulary keys out of order',
      (d) => {
        d.vocabulary = [d.vocabulary[1], d.vocabulary[0], d.vocabulary[2]];
      },
      'vocabulary key order',
    ],
    ['a non-finite idf', (d) => (d.vocabulary[2].idf = NaN), 'idf not finite'],
    ['a near id out of range', (d) => (d.vocabulary[2].near = [3]), 'near id out of range'],
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
        k[k.length - 1] = 3;
      },
      'addon userByTag key id out of range',
    ],
    [
      'user-side keys out of order',
      (d) => {
        const k = d.kinds.addon.userByEcosystem.keys;
        d.kinds.addon.userByEcosystem.keys = Uint32Array.from([k[0], ...k]);
      },
      'addon userByEcosystem',
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

  it('accepts the valid build as built (float64) and as decoded (float32)', async () => {
    expect(() => tagIndexFromData(data)).not.toThrow();
    await expect(decodeTagIndex(await encodeTagIndex(data, 'd'.repeat(64)))).resolves.toBeDefined();
  });
});
