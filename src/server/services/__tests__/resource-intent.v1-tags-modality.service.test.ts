import { beforeEach, describe, expect, it, vi } from 'vitest';

import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as JevModule from '~/server/services/ai/jev';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as CoocHolder from '~/server/services/resource-intent-cooc/holder';
import type * as MatcherModule from '~/server/services/resource-intent-matcher.service';
import type * as TagsHolder from '~/server/services/resource-intent-tags/holder';
import type { TagIndex, TagIndexKind } from '~/server/services/resource-intent-tags/score';

/**
 * The v1_tags arm's ecosystem source and modality, through the real scorer and gate: with no caller
 * baseModel the tags choose the ecosystem, and only among ecosystems whose base model generates
 * images; with one, the caller's ecosystem is used and the tags choose none. Jev, both snapshot
 * holders, the matcher's list functions, hydration, redis and ClickHouse are mocked at their seams.
 * Real base-model names, since the modality is read from their records.
 */

const mockAskJev = vi.fn();
const mockPoolMerge = vi.fn();
const mockV1Candidates = vi.fn();
const mockGetResourceData = vi.fn();
const mockInsert = vi.fn();
const mockTagResolve = vi.fn();

vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof JevModule>()),
  askJev: (...args: unknown[]) => mockAskJev(...(args as [])),
}));
vi.mock('~/server/services/resource-intent-matcher.service', async (importOriginal) => ({
  ...(await importOriginal<typeof MatcherModule>()),
  findPoolMergeCandidates: (...args: unknown[]) => mockPoolMerge(...(args as [])),
  findRankedCandidates: (...args: unknown[]) => mockV1Candidates(...(args as [])),
}));
vi.mock('~/server/services/resource-intent-cooc/holder', async (importOriginal) => ({
  ...(await importOriginal<typeof CoocHolder>()),
  coocSnapshotHolder: () => ({
    resolve: async () => ({ snapshot: null, fallbackReason: 'no_snapshot' }),
  }),
}));
vi.mock('~/server/services/resource-intent-tags/holder', async (importOriginal) => ({
  ...(await importOriginal<typeof TagsHolder>()),
  tagIndexSnapshotHolder: () => ({ resolve: mockTagResolve }),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: (...args: unknown[]) => mockGetResourceData(...(args as [])),
}));
vi.mock('~/server/clickhouse/client', () => ({
  get clickhouse() {
    return { insert: mockInsert };
  },
}));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));

const { getResourceIntent } = await import('~/server/services/resource-intent.service');
const { RESOURCE_INTENT_TAGS_SPEC_HASH } = await import(
  '~/server/services/resource-intent-tags/spec'
);
const { V1_TAGS_MIN_ECOSYSTEM_RESOURCES } = await import(
  '~/server/services/resource-intent-tags/gate'
);

const CTX = { browsingLevel: 3, coverage: { next: false, member: false } };
const V1 = { ...CTX, v1: true };
const SHADOW = { ...CTX, poolMerge: true, v1Shadow: true };

/**
 * Index ecosystems, every one above the user floor and with enough add-ons published under its own
 * name to pass the gate's floor; users and observations are pairwise distinct. Media types are the
 * records' own: 0 video, 1 image, 2 image and video, 3 video, 4 audio.
 *
 * Tag lift orders the ecosystems by count / observations:
 * - `zephyr`: MiniMax H3 > ACE Audio > Wan Video 2.2 T2V-A14B > Illustrious > Grok;
 * - `quokka`: Wan Video 2.2 T2V-A14B > Grok, the rest tied (so in users order).
 */
const ECOSYSTEMS = [
  { name: 'MiniMax H3', users: 900, observations: 101 },
  { name: 'Illustrious', users: 700, observations: 102 },
  { name: 'Grok', users: 500, observations: 103 },
  { name: 'Wan Video 2.2 T2V-A14B', users: 300, observations: 104 },
  { name: 'ACE Audio', users: 200, observations: 105 },
];
const TAG_COUNTS: [number, [number, number][]][] = [
  [
    0,
    [
      [0, 50],
      [4, 45],
      [3, 40],
      [1, 30],
      [2, 20],
    ],
  ],
  [
    1,
    [
      [3, 60],
      [2, 40],
    ],
  ],
];

function tagIndex(ecosystems = ECOSYSTEMS): TagIndex {
  const vocabulary = [
    { key: 'zephyr', idf: 2, near: [], explicit: false },
    { key: 'quokka', idf: 1.5, near: [], explicit: false },
  ];
  const fill = V1_TAGS_MIN_ECOSYSTEM_RESOURCES;
  const n = ecosystems.length * fill;
  const all = Array.from({ length: n }, (_, r) => r);
  // Each tag posts the first resource of every ecosystem, so every ecosystem ranks candidates.
  const firsts = ecosystems.map((_, e) => e * fill);
  const addon: TagIndexKind = {
    modelIds: all.map((r) => 10_000 + r),
    fit: new Float64Array(n),
    ecosystems: all.map((r) => [Math.floor(r / fill)]),
    postings: {
      ptr: Uint32Array.from([0, firsts.length, 2 * firsts.length]),
      resource: Uint32Array.from([...firsts, ...firsts]),
      c: Float64Array.from([...firsts, ...firsts], () => 0.5),
      fit: Float64Array.from([...firsts, ...firsts], () => NaN),
    },
    ecosystemUsers: new Map(),
    userByTag: new Map(),
    userByEcosystem: new Map(),
  };
  return {
    vocabulary,
    idByKey: new Map(vocabulary.map((t, i) => [t.key, i])),
    ecosystems,
    tagEcosystemCounts: new Map(
      TAG_COUNTS.map(([t, counts]) => [t, new Map(counts.filter(([e]) => e < ecosystems.length))])
    ),
    kinds: { addon, checkpoint: { ...addon, modelIds: [], ecosystems: [] } },
  };
}

const held = (index = tagIndex()) => ({
  snapshot: {
    id: '9',
    payloadSha256: 'c'.repeat(64),
    specHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
    vocabVersion: 'd'.repeat(64),
    createdAt: new Date('2026-10-20T00:00:00Z'),
    index,
  },
  fallbackReason: null,
});

const entry = (versionId: number, modelId: number) => ({
  versionId,
  modelId,
  modelName: `m${modelId}`,
  versionName: 'v1',
  baseModel: 'Illustrious',
  modelType: 'LORA',
  thumbsUpCount: 1,
});
const genResource = (id: number) => ({
  id,
  name: `version-${id}`,
  baseModel: 'Illustrious',
  strength: 0.8,
  minStrength: -1,
  maxStrength: 2,
  trainedWords: [],
  clipSkip: 2,
  hasAccess: true,
  canGenerate: true,
  model: { id: 100 + id, name: `model-${id}`, type: 'LORA', nsfw: false, poi: false, userId: 1 },
  air: `air:${id}`,
});

/** v1's own list (31, 32) and the POOL_MERGE list (21, 22) are disjoint. */
const V1_IDS = [31, 32];
const POOL_IDS = [21, 22];

type Insert = { table: string; values: Record<string, unknown>[] };
const shadowRows = () =>
  mockInsert.mock.calls
    .map((c) => c[0] as Insert)
    .filter((c) => c.table === 'resourceIntentShadow');
const shadowRow = async () => {
  await vi.waitFor(() => expect(shadowRows()).toHaveLength(1));
  return shadowRows()[0].values[0];
};
const ids = (r: { suggestions: { versionId: number }[] }) => r.suggestions.map((s) => s.versionId);
/** The baseModel term the v1 list was gated by. */
const gatedBy = () =>
  (mockV1Candidates.mock.calls[0][0] as { baseModel: string | Map<string, string[]> }).baseModel;
/** The LORA names an add-on list was gated by: a caller's ecosystem gates by its gate, as the tags' does. */
const loraGate = () => {
  const gate = gatedBy();
  expect(gate).toBeInstanceOf(Map);
  return (gate as Map<string, string[]>).get('LORA') ?? [];
};

beforeEach(() => {
  mockAskJev.mockReset();
  mockAskJev.mockResolvedValue({
    answers: [
      { id: 'needsResource', type: 'noul', value: 0.9 },
      { id: 'role', type: 'choice', value: 'style', distribution: { style: 0.9, none: 0.1 } },
      { id: 'styleFamily', type: 'choice', value: 'anime_manga', distribution: { anime_manga: 1 } },
      {
        id: 'contentType',
        type: 'choice',
        value: 'portrait_character',
        distribution: { portrait_character: 1 },
      },
      { id: 'specificity', type: 'score', value: 3 },
      { id: 'injectionPresent', type: 'noul', value: 0 },
    ],
    usage: { promptTokens: 1, completionTokens: 1 },
    model: 'typesafe/jev-1.13-20260917',
  });
  mockPoolMerge.mockReset();
  mockPoolMerge.mockResolvedValue({ entries: [entry(21, 2), entry(22, 3)], coocGated: 1 });
  mockV1Candidates.mockReset();
  mockV1Candidates.mockResolvedValue([entry(31, 101), entry(32, 102)]);
  mockGetResourceData.mockReset();
  mockGetResourceData.mockImplementation(async (vs: number[]) => vs.map(genResource));
  mockInsert.mockReset();
  mockInsert.mockResolvedValue(undefined);
  mockTagResolve.mockReset();
  mockTagResolve.mockResolvedValue(held());
  loggingMock.logToAxiom.mockReset();
  loggingMock.logToAxiom.mockResolvedValue(undefined);
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.set.mockResolvedValue('OK');
});

describe('🔴 without a baseModel, the tags choose only an ecosystem that generates images', () => {
  it('a video ecosystem the tags lean to is not chosen; the best image ecosystem gates the list', async () => {
    const result = await getResourceIntent({ prompt: 'zephyr' }, V1);
    expect(result).toMatchObject({ degraded: false, arm: 'v1_tags', v1Fallback: false });
    expect(result.ecosystems).toEqual(['Illustrious', 'Grok']);
    const gate = gatedBy() as Map<string, string[]>;
    expect(gate.get('LORA')).toContain('Illustrious');
    expect(gate.get('LORA')).not.toContain('MiniMax H3');
    expect(ids(result)).toEqual(V1_IDS);
    expect(await shadowRow()).toMatchObject({
      ecosystemSource: 'tags',
      ecosystemTop3: ['Illustrious', 'Grok'],
    });
  });

  it('an ecosystem whose base model generates both images and video stays eligible', async () => {
    const result = await getResourceIntent({ prompt: 'quokka' }, V1);
    expect(result.ecosystems).toEqual(['Grok', 'Illustrious']);
    expect((gatedBy() as Map<string, string[]>).get('LORA')).toContain('Grok');
  });

  it('with only video ecosystems in the index, there is no ecosystem and the POOL_MERGE list is served', async () => {
    mockTagResolve.mockResolvedValue(held(tagIndex([ECOSYSTEMS[0], ECOSYSTEMS[3]])));
    const result = await getResourceIntent({ prompt: 'zephyr' }, V1);
    expect(result).toMatchObject({ degraded: false, arm: 'v1_tags', v1Fallback: true });
    expect(mockV1Candidates).not.toHaveBeenCalled();
    expect(ids(result)).toEqual(POOL_IDS);
    expect(await shadowRow()).toMatchObject({
      v1FallbackReason: 'no_ecosystem',
      ecosystemSource: '',
      ecosystemTop3: [],
    });
  });

  it('the v1 shadow beside another arm applies the same eligibility', async () => {
    const result = await getResourceIntent({ prompt: 'zephyr' }, SHADOW);
    expect(ids(result)).toEqual(POOL_IDS);
    expect(await shadowRow()).toMatchObject({
      arm: 'pool_merge',
      shadowArm: 'v1_tags',
      shadowSuggestionIds: V1_IDS,
      ecosystemSource: 'tags',
      ecosystemTop3: ['Illustrious', 'Grok'],
    });
  });
});

describe("with a caller's baseModel the tags choose no ecosystem", () => {
  it("the caller's ecosystem gates by its compatible base models, and the row says so", async () => {
    const result = await getResourceIntent({ prompt: 'zephyr', baseModel: 'Illustrious' }, V1);
    expect(result).toMatchObject({ degraded: false, arm: 'v1_tags', v1Fallback: false });
    expect(result).not.toHaveProperty('ecosystems');
    expect(loraGate()).toEqual(expect.arrayContaining(['Illustrious', 'NoobAI']));
    expect(await shadowRow()).toMatchObject({ ecosystemSource: 'caller', ecosystemTop3: [] });
  });

  it("the modality rule does not override the caller's own ecosystem", async () => {
    await getResourceIntent({ prompt: 'quokka', baseModel: 'MiniMax H3' }, V1);
    expect(loraGate()).toContain('MiniMax H3');
    expect(await shadowRow()).toMatchObject({ ecosystemSource: 'caller', ecosystemTop3: [] });
  });

  it('the v1 shadow beside another arm uses the caller ecosystem too', async () => {
    await getResourceIntent({ prompt: 'zephyr', baseModel: 'Grok' }, SHADOW);
    // The shadow runs after the response: its row is written once its list is.
    expect(await shadowRow()).toMatchObject({
      shadowArm: 'v1_tags',
      ecosystemSource: 'caller',
      ecosystemTop3: [],
    });
    expect(loraGate()).toContain('Grok');
  });
});
