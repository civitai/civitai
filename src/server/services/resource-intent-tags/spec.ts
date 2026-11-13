import { createHash } from 'crypto';

import { NsfwLevel } from '~/server/common/enums';
import { ROLE_MODEL_TYPES } from '~/server/schema/resource-intent.schema';
import { matureBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { TagTrainingRow } from './build';
import { TAG_BUILD_PARAMS, TagIndexAccumulator } from './build';
import {
  compareCodePoints,
  matchVocabularyKeys,
  TAG_GRAM_SIZES,
  TAG_MAX_SEGMENT_TOKENS,
  TAG_STOPWORDS,
  tagKeySets,
  tagSegments,
} from './extract';
import { packTagIndex, TAG_INDEX_PAYLOAD_FORMAT } from './payload';
import type { TagIndex, TagIndexKind, TagVocabularyEntry } from './score';
import { scoreTagRequest, TAG_SCORE_PARAMS } from './score';
import { TAG_SOURCE_PARAMS } from './sources';

/**
 * The v1 content-tag arm's extractor, build, source and scorer constants and snapshot format, as the
 * prototype mined, built and screened with them, and the browsing levels that let a request match an
 * explicit tag.
 */
export const RESOURCE_INTENT_TAGS_SPEC = {
  maxSegmentTokens: TAG_MAX_SEGMENT_TOKENS,
  gramSizes: TAG_GRAM_SIZES,
  stopwords: [...TAG_STOPWORDS].sort(compareCodePoints),
  score: TAG_SCORE_PARAMS,
  matureLevels: matureBrowsingLevelsFlag,
  build: {
    ...TAG_BUILD_PARAMS,
    /** The resource types indexed as add-ons: every type a role admits, as the co-occurrence index. */
    addonTypes: [...new Set(Object.values(ROLE_MODEL_TYPES).flatMap((t) => t ?? []))].sort(),
  },
  sources: TAG_SOURCE_PARAMS,
  payloadFormat: TAG_INDEX_PAYLOAD_FORMAT,
} as const;

/**
 * Synthetic prompts chosen so that each normalisation step with an observable effect changes their
 * output (the `\(` unescape has none: brackets become separators either way). They are also cases
 * of the prototype parity fixture, so the hashed behaviour is the prototype's.
 */
export const RESOURCE_INTENT_TAGS_FINGERPRINT_PROMPTS = [
  '<lora:Foo_Bar:0.8> (Watercolor Paintings:1.2), embedding:EasyNeg lighthouse BREAK dusk, breakfast, ébreak, été break',
  "\\(escaped\\) [puppies] {kitties}, close-up; sci-fi | x-ies. glasses! iris? 1990s 12345, gas, cactus, boss, -dash-, 'quoted, 𠀀ies",
  'a quiet mountain village with snowy roofs under the warm evening light',
  "the of and, Café au lait, ＦＵＬＬ, ΟΔΟΣ, ❶, ፩, rock'n'roll, under_score, हिन्दी",
  'glow:\t2.5 lamp, glow:\u{feff}2.5 lamp, glow:\u{1c}2.5 lamp, glow:\u{85}2.5 lamp',
  'embedding:neg\u{feff}word tail, embedding:neg\u{1c}word tail',
  '﨎 hall, 𠀀 gate, lighthouse, mountain village',
] as const;

const FINGERPRINT_VOCABULARY = [
  'lighthouse',
  'puppy',
  'mountain village',
  'snowy roof',
  '﨎 hall',
  '𠀀 gate',
];

/** Sparse values from `[resource, value]` pairs. */
const values = (pairs: number[][]) => ({
  resource: Uint32Array.from(pairs, (p) => p[0]),
  value: Float64Array.from(pairs, (p) => p[1]),
});
const valueMap = (entries: [number, number[][]][]) =>
  new Map(entries.map(([k, pairs]) => [k, values(pairs)]));

/**
 * A four-tag, four-resource index: tag 0 is an explicit head holding tag 1 (so tag 1's weight is
 * half tag 0's idf, not its own); tags 1 and 2 tie on idf; the second ecosystem sits exactly on the
 * resolver's user floor and the third just below it; the explicit tag 0 leans hard toward the first
 * ecosystem, so the SFW requests' answer moves if a gated tag ever votes.
 */
const FP_TAGS: TagVocabularyEntry[] = [
  { key: 'amber kite', idf: 2.5, near: [1], explicit: true },
  { key: 'brass owl', idf: 1, near: [0], explicit: false },
  { key: 'cobalt fern', idf: 1, near: [], explicit: false },
  { key: 'dusk harbor', idf: 0.5, near: [], explicit: false },
];
const FP_KIND: TagIndexKind = {
  modelIds: [11, 12, 13, 14],
  fit: Float64Array.from([0.1, -0.2, 0, 0.3]),
  ecosystems: [[0], [0, 1], [1], [2]],
  postings: {
    ptr: Uint32Array.from([0, 1, 3, 5, 6]),
    resource: Uint32Array.from([0, 1, 2, 0, 3, 1]),
    c: Float64Array.from([0.9, 0.5, 0.4, 0.3, 0.8, 0]),
    fit: Float64Array.from([0.2, NaN, 0.1, NaN, NaN, 0.05]),
  },
  // prettier-ignore
  ecosystemUsers: valueMap([[0, [[0, 12], [1, 3]]], [1, [[1, 5], [2, 9]]]]),
  // prettier-ignore
  userByTag: valueMap([[1, [[1, 0.6], [2, 0.4]]], [2, [[0, 1]]]]),
  // prettier-ignore
  userByEcosystem: valueMap([[0, [[0, 0.7], [1, 0.3]]], [1, [[1, 0.5], [2, 0.5]]]]),
};
const FP_INDEX: TagIndex = {
  vocabulary: FP_TAGS,
  idByKey: new Map(FP_TAGS.map((t, i) => [t.key, i])),
  ecosystems: [
    { name: 'E1', users: 150, observations: 40 },
    { name: 'E2', users: 100, observations: 25 },
    { name: 'E3', users: 99, observations: 10 },
  ],
  // prettier-ignore
  tagEcosystemCounts: new Map([[0, new Map([[0, 40]])], [1, new Map([[0, 5], [1, 9]])], [2, new Map([[1, 3], [2, 4]])], [3, new Map([[0, 2]])]]),
  kinds: { addon: FP_KIND, checkpoint: FP_KIND },
};

function scorerFingerprint() {
  const prompt = 'amber kite, brass owl, cobalt fern, dusk harbor';
  return {
    requests: [
      { browsingLevel: NsfwLevel.PG | NsfwLevel.PG13, baseModel: null },
      { browsingLevel: NsfwLevel.Blocked, baseModel: null },
      { browsingLevel: NsfwLevel.R, baseModel: null },
      { browsingLevel: NsfwLevel.X, baseModel: 'E1' },
    ].map((r) => {
      const out = scoreTagRequest(FP_INDEX, { prompt, kind: 'addon', ...r });
      return { ...out, weights: [...out.weights] };
    }),
  };
}

/**
 * A build over a two-model, five-row fixture, as the snapshot bytes it packs to: every content source,
 * both outcome kinds, a two-checkpoint row with no ecosystem and a resource seen only in use.
 */
function buildFingerprint() {
  const tags = FP_TAGS.map((t, i) => ({ ...t, users: 10 + i }));
  const acc = new TagIndexAccumulator(
    { vocabVersion: 'f'.repeat(64), tags, idByKey: new Map(tags.map((t, i) => [t.key, i])) },
    { addonTypes: RESOURCE_INTENT_TAGS_SPEC.build.addonTypes, excludeGenPrompt: () => false }
  );
  acc.addModel({
    modelId: 21,
    type: 'LORA',
    name: 'Brass Owl Style',
    description: '<p>for <b>cobalt fern</b> &amp; more</p>',
    tags: ['dusk harbor'],
    trigger: ['amber kite, owl'],
    baseModels: ['E1', 'E2'],
    showcase: ['brass owl, cobalt fern', 'brass owl', 'dusk harbor'],
    gallery: ['a brass owl perched over the dusk harbor at night'],
  });
  acc.addModel({
    modelId: 22,
    type: 'Checkpoint',
    name: 'Base',
    description: '',
    tags: [],
    trigger: [],
    baseModels: ['E1'],
    showcase: [],
    gallery: [],
  });
  const lora = { modelId: 21, type: 'LORA', baseModel: 'E1' };
  const ckpt = { modelId: 22, type: 'Checkpoint', baseModel: 'E1' };
  const other = { modelId: 23, type: 'TextualInversion', baseModel: 'E2' };
  const rows: TagTrainingRow[] = [
    {
      source: 'gen',
      user: 'a',
      prompt: 'brass owl, dusk harbor',
      resources: [ckpt, lora],
      liked: true,
      favorite: false,
      disliked: false,
    },
    {
      source: 'gen',
      user: 'a',
      prompt: 'brass owl',
      resources: [ckpt, lora, other],
      liked: false,
      favorite: false,
      disliked: true,
    },
    {
      source: 'gen',
      user: 'b',
      prompt: 'brass owl, cobalt fern',
      resources: [ckpt, lora],
      liked: false,
      favorite: true,
      disliked: false,
    },
    {
      source: 'post',
      user: 'b',
      prompt: 'brass owl, amber kite',
      resources: [ckpt, other],
      reactions: 7,
      tips: 1,
    },
    {
      source: 'post',
      user: 'c',
      prompt: 'brass owl, dusk harbor',
      resources: [ckpt, { ...ckpt, modelId: 24, baseModel: 'E2' }, lora],
      reactions: 0,
      tips: 0,
    },
  ];
  for (const r of rows) acc.addRow(r);
  return createHash('sha256')
    .update(packTagIndex(acc.finalize().data, '0'.repeat(64)))
    .digest('hex');
}

/**
 * Hashes what the extractor produces on the fingerprint prompts, what the build packs on its fixture
 * and what the scorer produces on the fingerprint index, plus the constants. A behaviour change those
 * fixtures do not exercise does not move it.
 */
function tagsFingerprint() {
  const vocabulary = new Set(FINGERPRINT_VOCABULARY);
  return {
    spec: RESOURCE_INTENT_TAGS_SPEC,
    build: buildFingerprint(),
    scorer: scorerFingerprint(),
    out: RESOURCE_INTENT_TAGS_FINGERPRINT_PROMPTS.map((p) => {
      const { segment, gram } = tagKeySets(p);
      return {
        segments: tagSegments(p),
        segment: [...segment].sort(compareCodePoints),
        gram: [...gram].sort(compareCodePoints),
        matches: matchVocabularyKeys(p, vocabulary),
      };
    }),
  };
}

export const RESOURCE_INTENT_TAGS_SPEC_HASH = createHash('sha256')
  .update(JSON.stringify(tagsFingerprint()))
  .digest('hex');
