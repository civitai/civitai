import { beforeEach, describe, expect, it, vi } from 'vitest';

import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as MeiliClient from '~/server/meilisearch/client';
import type * as JevModule from '~/server/services/ai/jev';
import type * as CoverageSource from '~/server/services/generation/coverage-source';
import type * as CoocHolder from '~/server/services/resource-intent-cooc/holder';
import type * as TagsHolder from '~/server/services/resource-intent-tags/holder';
import type { TagIndex, TagIndexKind } from '~/server/services/resource-intent-tags/score';

/**
 * SEAM: the v1_tags arm, from the tag-chosen or caller's add-on ecosystem to the served list,
 * through the real scorer, gate and matcher. Faked: Jev, both snapshot holders, the search
 * index (which applies the type/baseModel clause of the filter it is handed, as Meilisearch would),
 * hydration and redis. Synthetic ids; real base-model names, since the gate reads their records.
 */

const mockAskJev = vi.fn();
const mockGetResourceData = vi.fn();
const searchWithSignal = vi.fn();
const mockTagResolve = vi.fn();

vi.mock('~/server/services/ai/jev', async (importOriginal) => ({
  ...(await importOriginal<typeof JevModule>()),
  askJev: (...args: unknown[]) => mockAskJev(...(args as [])),
}));
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<typeof MeiliClient>()),
  searchClient: { index: () => ({}) },
  searchWithSignal: (...args: unknown[]) => searchWithSignal(...args),
  withMeiliResourceSelect: (fn: (signal?: AbortSignal) => unknown) => fn(undefined),
  isTransientMeiliError: () => false,
}));
vi.mock('~/server/services/resource-intent-tags/holder', async (importOriginal) => ({
  ...(await importOriginal<typeof TagsHolder>()),
  tagIndexSnapshotHolder: () => ({ resolve: mockTagResolve }),
}));
vi.mock('~/server/services/resource-intent-cooc/holder', async (importOriginal) => ({
  ...(await importOriginal<typeof CoocHolder>()),
  coocSnapshotHolder: () => ({
    resolve: async () => ({ snapshot: null, fallbackReason: 'no_snapshot' }),
  }),
}));
vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: (...args: unknown[]) => mockGetResourceData(...(args as [])),
}));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: undefined }));
vi.mock('~/server/services/generation/coverage-source', async (importOriginal) => ({
  ...(await importOriginal<typeof CoverageSource>()),
  coverageAudience: vi.fn(async () => ({ next: false, member: false })),
}));

const { getResourceIntent } = await import('~/server/services/resource-intent.service');
const { RESOURCE_INTENT_TAGS_SPEC_HASH } = await import(
  '~/server/services/resource-intent-tags/spec'
);

const CTX = { browsingLevel: 3, coverage: { next: false, member: false }, v1: true };

/**
 * Index ecosystem ids: 0 'Krea 2 Turbo' (enough users, few add-ons under its own name), 1 'Krea 2'
 * (below the user floor, so never a resolver answer), 2 'OpenAI' (enough users, almost no add-ons).
 * Tag 0 leans to Krea 2 Turbo, tag 1 to OpenAI.
 */
const KREA_TURBO_OWN = 5;
// Above the eligibility floor (`V1_TAGS_MIN_ECOSYSTEM_RESOURCES`); a literal so this file also runs
// against code that predates the floor.
const KREA_BASE = 360;
const OPENAI_OWN = 3;
const KREA_RESOURCES = KREA_TURBO_OWN + KREA_BASE;
const MODEL_ID = (r: number) => 10_000 + r;
const VERSION_ID = (r: number) => 20_000 + r;
const PUBLISHED_AS = (r: number) =>
  r < KREA_TURBO_OWN ? 'Krea 2 Turbo' : r < KREA_RESOURCES ? 'Krea 2' : 'OpenAI';

function tagIndex(): TagIndex {
  const vocabulary = [
    { key: 'zephyr', idf: 2, near: [], explicit: false },
    { key: 'quokka', idf: 2, near: [], explicit: false },
  ];
  const n = KREA_RESOURCES + OPENAI_OWN;
  const all = Array.from({ length: n }, (_, r) => r);
  const krea = all.slice(0, KREA_RESOURCES);
  const openai = all.slice(KREA_RESOURCES);
  const ecoOf = (r: number) => (r < KREA_TURBO_OWN ? 0 : r < KREA_RESOURCES ? 1 : 2);
  const postings = [...krea, ...openai];
  const share = (rs: number[]) => ({
    resource: Uint32Array.from(rs),
    value: Float64Array.from(rs, () => 1 / rs.length),
  });
  const addon: TagIndexKind = {
    modelIds: all.map(MODEL_ID),
    fit: new Float64Array(n),
    ecosystems: all.map((r) => [ecoOf(r)]),
    postings: {
      ptr: Uint32Array.from([0, krea.length, postings.length]),
      resource: Uint32Array.from(postings),
      c: Float64Array.from(postings, (r) => 0.9 - r * 0.001),
      fit: Float64Array.from(postings, () => NaN),
    },
    ecosystemUsers: new Map(),
    userByTag: new Map(),
    // The Krea 2 add-ons are observed with Krea 2 Turbo checkpoints: its compatibility set.
    userByEcosystem: new Map([
      [0, share(krea)],
      [2, share(openai)],
    ]),
  };
  return {
    vocabulary,
    idByKey: new Map(vocabulary.map((t, i) => [t.key, i])),
    ecosystems: [
      { name: 'Krea 2 Turbo', users: 500, observations: 100 },
      { name: 'Krea 2', users: 50, observations: 20 },
      { name: 'OpenAI', users: 400, observations: 100 },
    ],
    tagEcosystemCounts: new Map([
      [0, new Map([[0, 60]])],
      [1, new Map([[2, 60]])],
    ]),
    kinds: { addon, checkpoint: { ...addon, modelIds: [], ecosystems: [] } },
  };
}

/** The search index: `id IN` restricts, and each `type = T AND versions.baseModel IN [..]` clause gates. */
function meili(_index: unknown, _q: string, params: { filter?: string; limit: number }) {
  const filter = params.filter ?? '';
  const ids = new Set(
    (filter.match(/\bid IN \[([^\]]*)\]/)?.[1] ?? '').split(',').map((s) => Number(s.trim()))
  );
  const gates = [...filter.matchAll(/type = "(\w+)" AND versions\.baseModel IN \[([^\]]*)\]/g)].map(
    ([, type, list]) => ({ type, baseModels: list.split(',').map((s) => s.trim().slice(1, -1)) })
  );
  const hits = [...ids]
    .filter((id) => id >= MODEL_ID(0))
    .map((id) => {
      const r = id - MODEL_ID(0);
      return {
        id,
        name: `m${id}`,
        type: 'LORA',
        metrics: { thumbsUpCount: 1 },
        versions: [{ id: VERSION_ID(r), name: 'v', baseModel: PUBLISHED_AS(r), canGenerate: true }],
      };
    })
    .filter((d) =>
      gates.some((g) => g.type === d.type && g.baseModels.includes(d.versions[0].baseModel))
    );
  return Promise.resolve({ hits: hits.slice(0, params.limit) });
}

const genResource = (id: number) => ({
  id,
  name: `version-${id}`,
  baseModel: 'Krea 2',
  strength: 0.8,
  minStrength: -1,
  maxStrength: 2,
  trainedWords: [],
  clipSkip: 2,
  hasAccess: true,
  canGenerate: true,
  model: { id: id + 1, name: `model-${id}`, type: 'LORA', nsfw: false, poi: false, userId: 1 },
  air: `air:${id}`,
});

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
  searchWithSignal.mockReset();
  searchWithSignal.mockImplementation(meili);
  mockGetResourceData.mockReset();
  mockGetResourceData.mockImplementation(async (ids: number[]) => ids.map(genResource));
  mockTagResolve.mockReset();
  mockTagResolve.mockResolvedValue({
    snapshot: {
      id: '1',
      payloadSha256: 'c'.repeat(64),
      specHash: RESOURCE_INTENT_TAGS_SPEC_HASH,
      vocabVersion: 'd'.repeat(64),
      createdAt: new Date('2026-10-19T00:00:00Z'),
      index: tagIndex(),
    },
    fallbackReason: null,
  });
  redisMock.redis.packed.get.mockReset();
  redisMock.redis.packed.get.mockResolvedValue(null);
  redisMock.redis.packed.set.mockReset();
  redisMock.redis.packed.set.mockResolvedValue('OK');
});

const versionIds = (r: { suggestions: { versionId: number }[] }) =>
  r.suggestions.map((s) => s.versionId);

describe('🔴 v1_tags without a baseModel: the tag-chosen ecosystem gates by its compatible base models', () => {
  it("fills the list from add-ons published under a sibling base model's name", async () => {
    const result = await getResourceIntent({ prompt: 'zephyr' }, CTX);
    expect(result).toMatchObject({ degraded: false, arm: 'v1_tags', v1Fallback: false });
    expect(result.ecosystems?.[0]).toBe('Krea 2 Turbo');
    // 50 is the arm's list width; the ecosystem's own name covers only KREA_TURBO_OWN of them.
    expect(result.suggestions).toHaveLength(50);
    expect(versionIds(result).slice(0, KREA_TURBO_OWN + 1)).toEqual(
      Array.from({ length: KREA_TURBO_OWN + 1 }, (_, r) => VERSION_ID(r))
    );
  });

  it('an ecosystem with too few add-ons under its gate is not chosen, though the tags lean to it', async () => {
    const result = await getResourceIntent({ prompt: 'quokka' }, CTX);
    expect(result.ecosystems).toEqual(['Krea 2 Turbo']);
    expect(result.v1Fallback).toBe(false);
    expect(versionIds(result).some((id) => id >= VERSION_ID(KREA_RESOURCES))).toBe(false);
    expect(result.suggestions).toHaveLength(50);
  });

  it("a caller's add-on baseModel gates by its compatible base models too", async () => {
    const result = await getResourceIntent({ prompt: 'zephyr', baseModel: 'Krea 2 Turbo' }, CTX);
    expect(result).not.toHaveProperty('ecosystems');
    // The ecosystem's own name covers only KREA_TURBO_OWN; the sibling's add-ons fill the rest.
    expect(result.suggestions).toHaveLength(50);
    expect(versionIds(result).slice(0, KREA_TURBO_OWN + 1)).toEqual(
      Array.from({ length: KREA_TURBO_OWN + 1 }, (_, r) => VERSION_ID(r))
    );
  });
});
