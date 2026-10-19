import type { TagIndexData, TagTrainingRow } from '~/server/services/resource-intent-tags/build';
import { TagIndexAccumulator } from '~/server/services/resource-intent-tags/build';
import { RESOURCE_INTENT_TAGS_SPEC } from '~/server/services/resource-intent-tags/spec';

/**
 * A small build: four tags (one explicit, one near two others), three ecosystems, two kinds. The near
 * sets ([2, 3]), published ecosystems ([1, 2]), posting lists ([0, 1, 2]), add-on model ids
 * ([3, 7, 11]) and per-tag user-side keys ([0, 1, 2]) hold rows that are not fixed points of delta
 * coding, so any of those stored without its deltas cannot round-trip. The per-ecosystem keys, the
 * sparse tables' resource lists and the (tag, ecosystem) ids are fixed points here, and are covered by
 * the build parity suite's snapshot cases instead.
 */
export function smallTagIndexData(vocabVersion: string): TagIndexData {
  const tags = [
    { key: 'amber kite', idf: Math.log(100 / 30), users: 30, explicit: false, near: [2, 3] },
    { key: 'brass owl', idf: Math.log(100 / 60), users: 60, explicit: true, near: [] },
    { key: 'cobalt fern', idf: Math.log(100 / 90), users: 90, explicit: false, near: [0] },
    { key: 'dusk harbor', idf: Math.log(100 / 70), users: 70, explicit: false, near: [0] },
  ];
  const acc = new TagIndexAccumulator(
    { vocabVersion, tags, idByKey: new Map(tags.map((t, i) => [t.key, i])) },
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
    modelId: 11,
    type: 'LORA',
    name: 'Amber Kite, Cobalt Fern, Dusk Harbor',
    baseModels: ['E2', 'E3'],
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
